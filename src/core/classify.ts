import type { ResolverInfo } from "./introspect.js";
import type { ScanResult, CallSite } from "./scan-frontend.js";

/**
 * M3 — the four-quadrant classification (deterministic, no LLM).
 *
 *                   frontend HAS call      frontend NO call          scanner CAN'T TELL
 *   schema HAS    → user_capability        no_entry                  unknown
 *                   (+ UI anchor + mount)  (dead / ops-only / cron)  (held, not concluded)
 *
 * `noise` is the mechanical pre-filter (introspection/Relay/health). The split
 * between `no_entry` and `unknown` is the honest one: we only conclude
 * "no entry" when the scanner is CONFIDENT. If the scan hit ANY unresolved
 * (dynamic) call-site, it has blind spots — a dynamic dispatch could be calling
 * any resolver — so every otherwise-uncalled resolver is `unknown`, not
 * `no_entry`. Tidy codebases → crisp no_entry; messy ones → more unknown. The
 * tool never breaks, it just converges at a different speed.
 */

export type Quadrant = "user_capability" | "no_entry" | "unknown" | "noise";

export interface ClassifiedPage {
  id: string;
  name: string;
}

export interface ClassifiedResolver {
  resolver: ResolverInfo;
  quadrant: Quadrant;
  /** Pages that call this resolver (only for user_capability). */
  pages: ClassifiedPage[];
  reason: string;
}

const NOISE_NAMES = new Set([
  "__typename",
  "__schema",
  "__type",
  "node",
  "nodes",
  "_entities",
  "_service",
  "health",
  "healthcheck",
  "healthCheck",
  "_health",
  "ping",
  "readiness",
  "liveness",
  "version",
]);

/** Obvious, no-judgement-needed noise — filtered mechanically. */
export function isMechanicalNoise(name: string): boolean {
  if (NOISE_NAMES.has(name)) return true;
  if (name.startsWith("__")) return true;
  return false;
}

export function classify(resolvers: ResolverInfo[], scan: ScanResult): ClassifiedResolver[] {
  const callsByResolver = new Map<string, CallSite[]>();
  for (const site of scan.sites) {
    const arr = callsByResolver.get(site.resolver) ?? [];
    arr.push(site);
    callsByResolver.set(site.resolver, arr);
  }
  // If the scan produced ANY unresolved (dynamic) site, it has blind spots and
  // cannot confidently rule out a call for any resolver.
  const scannerConfident = scan.unresolved.length === 0;

  return resolvers.map((resolver) => {
    if (isMechanicalNoise(resolver.name)) {
      return { resolver, quadrant: "noise" as const, pages: [], reason: "mechanical noise (introspection/Relay/health)" };
    }
    const calls = callsByResolver.get(resolver.name);
    if (calls && calls.length) {
      const pages = dedupePages(calls.map((c) => ({ id: c.pageId, name: c.pageName })));
      return {
        resolver,
        quadrant: "user_capability" as const,
        pages,
        reason: `called from ${pages.map((p) => p.name).join(", ")}`,
      };
    }
    if (scannerConfident) {
      return {
        resolver,
        quadrant: "no_entry" as const,
        pages: [],
        reason: "no frontend call found (scanner confident — no dynamic sites)",
      };
    }
    return {
      resolver,
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

/** Summary counts per quadrant — for build/check reporting. */
export function quadrantCounts(classified: ClassifiedResolver[]): Record<Quadrant, number> {
  const counts: Record<Quadrant, number> = { user_capability: 0, no_entry: 0, unknown: 0, noise: 0 };
  for (const c of classified) counts[c.quadrant]++;
  return counts;
}
