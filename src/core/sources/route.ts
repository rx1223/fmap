import fs from "node:fs";
import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { walkFiles } from "../fs-utils.js";
import { createFrontendProject, staticPathPattern, type UsageResult } from "../frontend-ast.js";
import { scanRestUsage, normalizeDefinitionPath } from "./rest-usage.js";
import type { Operation } from "../operation.js";
import type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/**
 * Route-handler capability source — for projects with no formal API spec.
 * Operations come from backend route definitions:
 *   - Express/Fastify:  app.get('/x', h) / router.post('/x', h)
 *   - Next.js app router: app/**\/route.ts exporting GET/POST/…
 *   - Next.js pages API:  pages/api/**.ts (method unknown → ALL)
 * The code anchor points at the handler file. Usage is matched from frontend
 * fetch/axios call-sites via the shared REST scanner.
 */

const EXPRESS_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const ROUTER_ID_RE = /^(app|router|fastify|server|api|r|route|routes)$/;
const NEXT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const NOISE_PATH_RE = /\/(health|healthz|ping|metrics|readiness|liveness|version|favicon)\b/i;
const ROUTE_FILE_RE = /^route\.(t|j)sx?$/;
const BACKENDISH = /(^|[\\/])(server|api|routes|backend|functions|src|app|pages)([\\/]|$)/;

export const routeSource: CapabilitySource = {
  id: "route",
  title: "Route handlers",

  detect(projectRoot: string): DetectionResult | null {
    const kinds = detectRouteKinds(projectRoot);
    if (kinds.size === 0) return null;
    return { config: { type: "route", root: "." }, summary: `Route handlers (${[...kinds].join(", ")})` };
  },

  async loadOperations(cfg: SourceConfig, projectRoot: string): Promise<Operation[]> {
    const root = (cfg.root as string) || ".";
    const scanRoot = path.isAbsolute(root) ? root : path.join(projectRoot, root);
    return scanRoutes(scanRoot, projectRoot);
  },

  scanUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
    return scanRestUsage(operations, frontendRoot, projectRoot);
  },
};

// ── Detection ────────────────────────────────────────────────────────────────

function detectRouteKinds(cwd: string): Set<string> {
  const kinds = new Set<string>();
  const files = walkFiles(cwd, { filter: (p) => /\.(tsx?|jsx?|mts|cts)$/.test(p) && !p.endsWith(".d.ts"), limit: 1500 });
  let sniffs = 0;
  for (const f of files) {
    const rel = path.relative(cwd, f);
    const segs = rel.split(path.sep);
    if (ROUTE_FILE_RE.test(path.basename(f)) && segs.includes("app")) kinds.add("next-app");
    else if (segs.includes("pages") && segs.includes("api")) kinds.add("next-pages");
    else if (BACKENDISH.test(rel) && sniffs < 500) {
      sniffs++;
      try {
        if (/\b(app|router|fastify|server)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]\//.test(fs.readFileSync(f, "utf8"))) {
          kinds.add("express");
        }
      } catch {
        /* ignore */
      }
    }
    if (kinds.size >= 3) break;
  }
  return kinds;
}

// ── Route definitions → operations ───────────────────────────────────────────

function scanRoutes(scanRoot: string, projectRoot: string): Operation[] {
  const project = createFrontendProject(scanRoot);
  const byName = new Map<string, Operation>();

  const add = (method: string, rawPath: string, anchor: string) => {
    const route = method === "ALL" ? rawPath : normalizeDefinitionPath(rawPath);
    const name = `${method} ${route}`;
    if (byName.has(name)) return;
    byName.set(name, {
      sourceId: "route",
      name,
      kind: method,
      entities: [],
      anchor,
      noise: NOISE_PATH_RE.test(route),
    });
  };

  for (const sf of project.getSourceFiles()) {
    const rel = path.relative(projectRoot, sf.getFilePath());
    const segs = rel.split(path.sep);
    const base = path.basename(sf.getFilePath());

    // Next.js app router: app/**/route.ts → exported method functions.
    if (ROUTE_FILE_RE.test(base) && segs.includes("app")) {
      const url = nextAppUrl(segs);
      if (url) for (const m of exportedMethodNames(sf)) add(m, url, `${rel}#${m}`);
    }
    // Next.js pages API: pages/api/**.ts → method unknown (ALL).
    else if (segs.includes("pages") && segs.includes("api")) {
      const url = pagesApiUrl(segs);
      if (url) add("ALL", url, rel);
    }

    // Express/Fastify method calls (can appear in any file).
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName().toLowerCase();
      if (!EXPRESS_METHODS.has(method)) continue;
      const obj = callee.getExpression();
      if (!Node.isIdentifier(obj) || !ROUTER_ID_RE.test(obj.getText())) continue;
      const arg0 = call.getArguments()[0];
      if (!arg0) continue;
      const raw = staticPathPattern(arg0);
      if (raw === null || !raw.startsWith("/")) continue;
      add(method === "all" ? "ALL" : method.toUpperCase(), raw, rel);
    }
  }

  return [...byName.values()];
}

function exportedMethodNames(sf: SourceFile): string[] {
  const out = new Set<string>();
  for (const fn of sf.getFunctions()) {
    const n = fn.getName();
    if (n && NEXT_METHODS.has(n) && fn.isExported()) out.add(n);
  }
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const d of vs.getDeclarations()) if (NEXT_METHODS.has(d.getName())) out.add(d.getName());
  }
  return [...out];
}

function nextAppUrl(segs: string[]): string | null {
  const ai = segs.lastIndexOf("app");
  if (ai === -1) return null;
  const between = segs.slice(ai + 1, segs.length - 1); // dirs between app/ and the route file
  const parts = between.filter((s) => !/^\(.*\)$/.test(s)).map(dynamicSegment);
  return "/" + parts.join("/");
}

function pagesApiUrl(segs: string[]): string | null {
  const pi = segs.lastIndexOf("pages");
  if (pi === -1 || segs[pi + 1] !== "api") return null;
  const after = segs.slice(pi + 1);
  let last = after[after.length - 1].replace(/\.(t|j)sx?$/, "");
  if (last === "index") after.pop();
  else after[after.length - 1] = last;
  return "/" + after.map(dynamicSegment).join("/");
}

/** [id] → {id}, [...slug] / [[...slug]] → {slug}; literals unchanged. */
function dynamicSegment(seg: string): string {
  const rest = seg.match(/^\[\[?\.\.\.(.+?)\]?\]$/);
  if (rest) return `{${rest[1]}}`;
  const param = seg.match(/^\[(.+?)\]$/);
  if (param) return `{${param[1]}}`;
  return seg;
}
