import { Node, SyntaxKind } from "ts-morph";
import {
  createFrontendProject,
  pageFor,
  staticPathPattern,
  UsageCollector,
  type UsageResult,
} from "../frontend-ast.js";
import type { Operation } from "../operation.js";

/**
 * Shared HTTP usage scanner for REST-shaped sources (OpenAPI + route handlers).
 * Matches frontend fetch/axios call-sites to operations whose name is
 * "<METHOD> <path-template>" by turning URLs into path patterns and
 * suffix-matching path segments (so a `/api/v1` base path is tolerated).
 * An operation kind of "ALL" matches any method (e.g. a Next pages/api handler).
 */

const VERB_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const HTTP_CLIENT_RE = /^(axios|api|http|client|request|\$http|instance|fetcher)$/i;

export function scanRestUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
  const project = createFrontendProject(frontendRoot);
  const collector = new UsageCollector();

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const hit = httpCallOf(call);
      if (!hit) continue;
      const pattern = staticPathPattern(hit.urlNode);
      if (pattern === null) {
        if (hit.definitelyHttp) collector.addUnresolved(filePath, projectRoot, "dynamic request URL", call);
        continue;
      }
      const normalized = normalizePath(pattern);
      if (!normalized) continue;
      const match = bestMatch(normalized, hit.method, operations);
      if (match) collector.addSite(match.name, match.kind, pageFor(call, filePath, projectRoot));
    }
  }
  return collector.result();
}

interface HttpCall {
  method: string;
  urlNode: Node;
  definitelyHttp: boolean;
}

function httpCallOf(call: Node): HttpCall | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const args = call.getArguments();

  const calleeName = Node.isIdentifier(callee)
    ? callee.getText()
    : Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : "";
  if (calleeName === "fetch" && args[0]) {
    return { method: methodFromOptions(args[1]) ?? "GET", urlNode: args[0], definitelyHttp: true };
  }

  if (Node.isIdentifier(callee) && HTTP_CLIENT_RE.test(callee.getText()) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const url = propInit(args[0], "url");
    if (url) return { method: (stringProp(args[0], "method") ?? "GET").toUpperCase(), urlNode: url, definitelyHttp: true };
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const verb = callee.getName().toLowerCase();
    if (VERB_METHODS.has(verb) && args[0]) {
      const obj = callee.getExpression();
      const looksLikeClient = Node.isIdentifier(obj) && HTTP_CLIENT_RE.test(obj.getText());
      const p = staticPathPattern(args[0]);
      if (looksLikeClient || (p !== null && /\//.test(p))) {
        return { method: verb.toUpperCase(), urlNode: args[0], definitelyHttp: looksLikeClient };
      }
    }
  }
  return undefined;
}

function methodFromOptions(node: Node | undefined): string | undefined {
  if (node && Node.isObjectLiteralExpression(node)) {
    const m = stringProp(node, "method");
    if (m) return m.toUpperCase();
  }
  return undefined;
}

function stringProp(obj: Node, name: string): string | undefined {
  const init = propInit(obj, name);
  if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
    return init.getLiteralText();
  }
  return undefined;
}

function propInit(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.getProperty(name);
  return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
}

/** Strip origin + query/hash, ensure a leading slash; null if not path-like. */
export function normalizePath(raw: string): string | null {
  let s = raw.trim().replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  if (!s.startsWith("/")) {
    if (!s.includes("/")) return null;
    s = "/" + s;
  }
  return s || "/";
}

/** Normalise a route-definition path to {param} template form (`:id`/`*` → `{…}`). */
export function normalizeDefinitionPath(raw: string): string {
  return raw
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\*/g, "{wild}");
}

/** Suffix-match a request path against operation path templates; most specific wins. */
function bestMatch(reqPath: string, method: string, ops: Operation[]): Operation | undefined {
  const fseg = reqPath.split("/").filter(Boolean);
  let best: Operation | undefined;
  let bestLiterals = -1;
  for (const op of ops) {
    if (op.kind !== method && op.kind !== "ALL") continue;
    const oseg = (op.name.split(" ")[1] ?? "").split("/").filter(Boolean);
    if (oseg.length > fseg.length) continue;
    const offset = fseg.length - oseg.length;
    let ok = true;
    let literals = 0;
    for (let i = 0; i < oseg.length; i++) {
      const o = oseg[i];
      const f = fseg[offset + i];
      const wild = /^\{.*\}$/.test(o) || f === "*";
      if (wild) continue;
      if (o !== f) {
        ok = false;
        break;
      }
      literals++;
    }
    if (ok && literals > bestLiterals) {
      best = op;
      bestLiterals = literals;
    }
  }
  return best;
}
