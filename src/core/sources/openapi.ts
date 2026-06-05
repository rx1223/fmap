import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Node, SyntaxKind } from "ts-morph";
import { walkFiles, fileExists } from "../fs-utils.js";
import {
  createFrontendProject,
  pageFor,
  staticPathPattern,
  UsageCollector,
  type UsageResult,
} from "../frontend-ast.js";
import type { Operation } from "../operation.js";
import type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/**
 * OpenAPI / REST capability source. Operations come from an OpenAPI (v3) or
 * Swagger (v2) spec — one per path × method. Usage is matched from frontend
 * fetch/axios call-sites by turning URLs into path patterns and suffix-matching
 * them against the spec's path templates (so a `/api/v1` base path is tolerated).
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const VERB_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const NOISE_PATH_RE = /\/(health|healthz|ping|metrics|readiness|liveness|version|favicon)\b/i;
const HTTP_CLIENT_RE = /^(axios|api|http|client|request|\$http|instance|fetcher)$/i;

export const openapiSource: CapabilitySource = {
  id: "openapi",
  title: "OpenAPI / REST",

  detect(projectRoot: string): DetectionResult | null {
    const specPath = detectSpec(projectRoot);
    if (!specPath) return null;
    return { config: { type: "openapi", specPath }, summary: `OpenAPI/REST (${specPath})` };
  },

  async loadOperations(cfg: SourceConfig, projectRoot: string): Promise<Operation[]> {
    const specPath = cfg.specPath as string | undefined;
    if (!specPath) throw new Error("openapi source needs `specPath` in the config.");
    const abs = path.isAbsolute(specPath) ? specPath : path.join(projectRoot, specPath);
    if (!fileExists(abs)) throw new Error(`OpenAPI spec not found: ${abs}`);
    const spec = parseSpec(abs);
    return specToOperations(spec);
  },

  scanUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
    return scanRestUsage(operations, frontendRoot, projectRoot);
  },
};

// ── Detection ────────────────────────────────────────────────────────────────

function detectSpec(cwd: string): string | undefined {
  const direct = [
    "openapi.yaml",
    "openapi.yml",
    "openapi.json",
    "swagger.yaml",
    "swagger.yml",
    "swagger.json",
    "api/openapi.yaml",
    "api/openapi.json",
    "docs/openapi.yaml",
  ];
  for (const name of direct) if (fileExists(path.join(cwd, name))) return name;
  // Content sniff a bounded set of yaml/json files for an openapi/swagger marker.
  const files = walkFiles(cwd, { filter: (p) => /\.(ya?ml|json)$/i.test(p), limit: 150 });
  for (const f of files) {
    try {
      const head = fs.readFileSync(f, "utf8").slice(0, 400);
      if (/["']?(openapi|swagger)["']?\s*:/.test(head)) return path.relative(cwd, f);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// ── Spec → operations ────────────────────────────────────────────────────────

interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
}

function parseSpec(abs: string): OpenApiSpec {
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = abs.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  return (parsed ?? {}) as OpenApiSpec;
}

function specToOperations(spec: OpenApiSpec): Operation[] {
  const out: Operation[] = [];
  const paths = spec.paths ?? {};
  for (const [route, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      const operation = op as Record<string, unknown>;
      const m = method.toUpperCase();
      const noise = !VERB_METHODS.has(method.toLowerCase()) || NOISE_PATH_RE.test(route);
      out.push({
        sourceId: "openapi",
        name: `${m} ${route}`,
        kind: m,
        entities: [...collectRefs(operation)].sort(),
        description: (operation.summary as string) || (operation.description as string) || undefined,
        deprecated: operation.deprecated === true,
        noise,
      });
    }
  }
  return out;
}

/** Recursively collect referenced component schema names ($ref → last segment). */
function collectRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") {
      const seg = v.split("/").pop();
      if (seg) out.add(seg);
    } else {
      collectRefs(v, out);
    }
  }
  return out;
}

// ── Usage scan (best-effort) ─────────────────────────────────────────────────

function scanRestUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
  const project = createFrontendProject(frontendRoot);
  const collector = new UsageCollector();
  const opsByMethod = new Map<string, Operation[]>();
  for (const op of operations) {
    const arr = opsByMethod.get(op.kind) ?? [];
    arr.push(op);
    opsByMethod.set(op.kind, arr);
  }

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
      if (!normalized) continue; // a string, but not path-like → not an API call we model
      const match = bestMatch(normalized, hit.method, opsByMethod.get(hit.method) ?? []);
      if (match) collector.addSite(match.name, match.kind, pageFor(call, filePath, projectRoot));
    }
  }
  return collector.result();
}

interface HttpCall {
  method: string;
  urlNode: Node;
  /** fetch()/axios() are unambiguously HTTP → a dynamic URL is a real blind spot. */
  definitelyHttp: boolean;
}

function httpCallOf(call: Node): HttpCall | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const args = call.getArguments();

  // fetch(url, { method }) / window.fetch(...)
  const calleeName = Node.isIdentifier(callee)
    ? callee.getText()
    : Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : "";
  if (calleeName === "fetch" && args[0]) {
    return { method: methodFromOptions(args[1]) ?? "GET", urlNode: args[0], definitelyHttp: true };
  }

  // axios({ url, method }) / api({...})
  if (Node.isIdentifier(callee) && HTTP_CLIENT_RE.test(callee.getText()) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const url = propInit(args[0], "url");
    if (url) return { method: (stringProp(args[0], "method") ?? "GET").toUpperCase(), urlNode: url, definitelyHttp: true };
  }

  // axios.get(url) / api.post(url, body) — only when the arg is a path-like string.
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
function normalizePath(raw: string): string | null {
  let s = raw.trim().replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  if (!s.startsWith("/")) {
    if (!s.includes("/")) return null;
    s = "/" + s;
  }
  return s || "/";
}

/** Suffix-match a request path against operation path templates; most specific wins. */
function bestMatch(reqPath: string, method: string, ops: Operation[]): Operation | undefined {
  const fseg = reqPath.split("/").filter(Boolean);
  let best: Operation | undefined;
  let bestLiterals = -1;
  for (const op of ops) {
    if (op.kind !== method) continue;
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
