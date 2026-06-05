import type { Operation } from "./operation.js";
import type { UsageResult, CallSite } from "./frontend-ast.js";

/**
 * The four-quadrant classification (deterministic, no LLM). Source-agnostic:
 * it classifies generic Operations against frontend usage, regardless of
 * protocol.
 *
 *                   frontend HAS call      frontend NO call          scanner CAN'T TELL
 *   backend HAS    → user_capability        no_entry                  unknown
 *                    (+ UI anchor + mount)  (dead / ops-only / cron)  (held, not concluded)
 *
 * `noise` is the mechanical pre-filter: protocol-specific noise is flagged by
 * the source (`operation.noise`); cross-protocol noise (health/ping/…) is
 * caught here. The `no_entry` vs `unknown` split is the honest one: we only
 * conclude "no entry" when the scanner is CONFIDENT (no unresolved dynamic
 * sites). Tidy codebases → crisp no_entry; messy ones → more unknown.
 */

export type Quadrant = "user_capability" | "no_entry" | "unknown" | "noise";

export interface ClassifiedPage {
  id: string;
  name: string;
}

export interface ClassifiedOperation {
  operation: Operation;
  quadrant: Quadrant;
  /** Pages that call this operation (only for user_capability). */
  pages: ClassifiedPage[];
  reason: string;
}

// Cross-protocol noise — operations no user asks about, regardless of source.
const UNIVERSAL_NOISE = new Set([
  "health",
  "healthcheck",
  "healthCheck",
  "_health",
  "ping",
  "readiness",
  "liveness",
  "version",
  "__typename",
]);

export function isUniversalNoise(name: string): boolean {
  return UNIVERSAL_NOISE.has(name) || name.startsWith("__");
}

export function classify(operations: Operation[], usage: UsageResult): ClassifiedOperation[] {
  const callsByOperation = new Map<string, CallSite[]>();
  for (const site of usage.sites) {
    const arr = callsByOperation.get(site.operation) ?? [];
    arr.push(site);
    callsByOperation.set(site.operation, arr);
  }
  // Any unresolved (dynamic) site means the scan has blind spots and can't
  // confidently rule out a call for any operation.
  const scannerConfident = usage.unresolved.length === 0;

  return operations.map((operation) => {
    if (operation.noise || isUniversalNoise(operation.name)) {
      return { operation, quadrant: "noise" as const, pages: [], reason: "mechanical noise" };
    }
    const calls = callsByOperation.get(operation.name);
    if (calls && calls.length) {
      const pages = dedupePages(calls.map((c) => ({ id: c.pageId, name: c.pageName })));
      return {
        operation,
        quadrant: "user_capability" as const,
        pages,
        reason: `called from ${pages.map((p) => p.name).join(", ")}`,
      };
    }
    if (scannerConfident) {
      return {
        operation,
        quadrant: "no_entry" as const,
        pages: [],
        reason: "no frontend call found (scanner confident — no dynamic sites)",
      };
    }
    return {
      operation,
      quadrant: "unknown" as const,
      pages: [],
      reason: "no static call found, but the scan has blind spots (unresolved dynamic sites exist)",
    };
  });
}

function dedupePages(pages: ClassifiedPage[]): ClassifiedPage[] {
  const byId = new Map<string, ClassifiedPage>();
  for (const p of pages) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

export function quadrantCounts(classified: ClassifiedOperation[]): Record<Quadrant, number> {
  const counts: Record<Quadrant, number> = { user_capability: 0, no_entry: 0, unknown: 0, noise: 0 };
  for (const c of classified) counts[c.quadrant]++;
  return counts;
}
