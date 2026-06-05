import fs from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import { walkFiles } from "../fs-utils.js";
import { createFrontendProject, pageFor, UsageCollector, type UsageResult } from "../frontend-ast.js";
import type { Operation } from "../operation.js";
import type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/**
 * tRPC capability source. Operations are the procedures of the router tree —
 * walked statically through nested `t.router({...})` / `createTRPCRouter({...})`
 * (resolving sub-router consts) into dotted paths like `store.revenue.today`.
 * Usage is matched from `trpc.a.b.useQuery()` / `.useMutation()` client chains.
 *
 * tRPC chains are static member accesses, so this is the "tidy" case: uncalled
 * procedures land in no_entry, not unknown.
 */

const ROUTER_FNS = new Set(["router", "createTRPCRouter", "createRouter"]);
const PROCEDURE_TERMINALS = new Set(["query", "mutation", "subscription"]);
const CLIENT_HOOKS = new Set([
  "useQuery",
  "useMutation",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSuspenseInfiniteQuery",
  "useSubscription",
  "query",
  "mutate",
]);
const CLIENT_ROOT_RE = /^(trpc|api|client|trpcClient|reactClient)$/;

export const trpcSource: CapabilitySource = {
  id: "trpc",
  title: "tRPC",

  detect(projectRoot: string): DetectionResult | null {
    const hit = detectRouter(projectRoot);
    if (!hit) return null;
    return {
      config: { type: "trpc", routerPath: hit.routerPath, root: hit.root },
      summary: `tRPC (${hit.routerPath})`,
    };
  },

  async loadOperations(cfg: SourceConfig, projectRoot: string): Promise<Operation[]> {
    const root = (cfg.root as string) || ".";
    const scanRoot = path.isAbsolute(root) ? root : path.join(projectRoot, root);
    return routerToOperations(scanRoot, cfg.rootName as string | undefined);
  },

  scanUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
    return scanTrpcUsage(operations, frontendRoot, projectRoot);
  },
};

// ── Detection ────────────────────────────────────────────────────────────────

function detectRouter(cwd: string): { routerPath: string; root: string } | undefined {
  const files = walkFiles(cwd, { filter: (p) => /\.(tsx?|mts|cts)$/.test(p) && !p.endsWith(".d.ts"), limit: 800 });
  let firstTrpc: string | undefined;
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!/initTRPC|createTRPCRouter|@trpc\/server/.test(text)) continue;
    firstTrpc ??= f;
    if (/\bappRouter\b/.test(text)) {
      return { routerPath: path.relative(cwd, f), root: path.relative(cwd, path.dirname(f)) || "." };
    }
  }
  if (firstTrpc) {
    return { routerPath: path.relative(cwd, firstTrpc), root: path.relative(cwd, path.dirname(firstTrpc)) || "." };
  }
  return undefined;
}

// ── Router tree → operations ─────────────────────────────────────────────────

function routerToOperations(scanRoot: string, rootName?: string): Operation[] {
  const project = createFrontendProject(scanRoot); // same ts-morph setup works for backend TS
  // Map const name → the object literal passed to a router(...) call.
  const routerObjects = new Map<string, Node>();
  for (const sf of project.getSourceFiles()) {
    for (const vd of sf.getVariableDeclarations()) {
      const init = vd.getInitializer();
      const obj = init && routerArgObject(init);
      if (obj) routerObjects.set(vd.getName(), obj);
    }
  }
  if (routerObjects.size === 0) return [];

  const rootObj =
    (rootName && routerObjects.get(rootName)) ??
    routerObjects.get("appRouter") ??
    routerObjects.get("rootRouter") ??
    (routerObjects.size === 1 ? [...routerObjects.values()][0] : undefined) ??
    [...routerObjects.entries()].find(([n]) => /router/i.test(n))?.[1];
  if (!rootObj) return [];

  const ops: Operation[] = [];
  const seen = new Set<string>();
  walkRouter(rootObj, "", routerObjects, ops, seen);
  return ops;
}

function walkRouter(
  obj: Node,
  prefix: string,
  routerObjects: Map<string, Node>,
  out: Operation[],
  seen: Set<string>,
): void {
  if (!Node.isObjectLiteralExpression(obj)) return;
  const key = `${obj.getSourceFile().getFilePath()}:${obj.getStart()}:${prefix}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const prop of obj.getProperties()) {
    let key: string | undefined;
    let valueObj: Node | undefined;
    let procedureCall: Node | undefined;

    if (Node.isPropertyAssignment(prop)) {
      key = prop.getName();
      const init = prop.getInitializer();
      if (init) {
        const ro = routerArgObject(init);
        if (ro) valueObj = ro;
        else if (Node.isIdentifier(init)) valueObj = routerObjects.get(init.getText());
        else if (isProcedureCall(init)) procedureCall = init;
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      key = prop.getName();
      valueObj = routerObjects.get(key);
    }
    if (!key) continue;

    const dotted = prefix ? `${prefix}.${key}` : key;
    if (valueObj) {
      walkRouter(valueObj, dotted, routerObjects, out, seen);
    } else if (procedureCall) {
      out.push({
        sourceId: "trpc",
        name: dotted,
        kind: terminalMethod(procedureCall) ?? "query",
        entities: [capitalize(dotted.split(".")[0])],
      });
    }
  }
}

/** If `node` is a router(...) call, return its first-arg object literal. */
function routerArgObject(node: Node): Node | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  const name = Node.isIdentifier(callee)
    ? callee.getText()
    : Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : "";
  if (!ROUTER_FNS.has(name)) return undefined;
  const arg = node.getArguments()[0];
  return arg && Node.isObjectLiteralExpression(arg) ? arg : undefined;
}

function isProcedureCall(node: Node): boolean {
  return terminalMethod(node) !== undefined;
}

/** The outermost builder method of a procedure chain: query | mutation | subscription. */
function terminalMethod(node: Node): string | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (Node.isPropertyAccessExpression(callee)) {
    const n = callee.getName();
    if (PROCEDURE_TERMINALS.has(n)) return n;
  }
  return undefined;
}

// ── Usage scan ───────────────────────────────────────────────────────────────

function scanTrpcUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
  const project = createFrontendProject(frontendRoot);
  const collector = new UsageCollector();
  const byPath = new Map(operations.map((o) => [o.name, o]));

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const chain = trpcCallPath(call);
      if (!chain) continue;
      const op = byPath.get(chain.path);
      if (op) collector.addSite(op.name, op.kind, pageFor(call, filePath, projectRoot));
      // No match → likely a utils/invalidate chain or a different client; skip silently.
    }
  }
  return collector.result();
}

/** Extract the procedure path from a `trpc.a.b.useQuery(...)`-style chain. */
function trpcCallPath(call: Node): { path: string; hook: string } | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const hook = callee.getName();
  if (!CLIENT_HOOKS.has(hook)) return null;

  const segs: string[] = [];
  let cur: Node | undefined = callee.getExpression();
  while (cur) {
    if (Node.isPropertyAccessExpression(cur)) {
      segs.unshift(cur.getName());
      cur = cur.getExpression();
    } else if (Node.isIdentifier(cur)) {
      segs.unshift(cur.getText());
      break;
    } else {
      return null; // a call / computed access in the chain → can't resolve statically
    }
  }
  if (segs.length < 2) return null;
  const root = segs[0];
  if (!CLIENT_ROOT_RE.test(root)) return null;
  return { path: segs.slice(1).join("."), hook };
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
