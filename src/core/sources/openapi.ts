import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { walkFiles, fileExists } from "../fs-utils.js";
import type { UsageResult } from "../frontend-ast.js";
import { scanRestUsage } from "./rest-usage.js";
import type { Operation } from "../operation.js";
import type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/**
 * OpenAPI / REST capability source. Operations come from an OpenAPI (v3) or
 * Swagger (v2) spec — one per path × method. Usage is matched from frontend
 * fetch/axios call-sites (shared REST scanner).
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const VERB_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const NOISE_PATH_RE = /\/(health|healthz|ping|metrics|readiness|liveness|version|favicon)\b/i;

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
