import type { Capability, PageNode, Sitemap } from "./model.js";
import { pagePath } from "./sitemap.js";

/**
 * The pure query engine — shared by the CLI (`fmap query`) and the MCP server
 * (`fmap query --serve`). No I/O, no console. Locating a capability and
 * resolving "how to reach it" must give one answer regardless of frontend.
 */

export interface ScoredCapability {
  capability: Capability;
  score: number;
}

export interface ReachPath {
  pageId: string;
  /** Root→page node chain from pagePath(); [] when the page isn't in the sitemap. */
  path: PageNode[];
  /** Page names joined with "  ›  " (the CLI's display string); "" if unresolved. */
  display: string;
  /** True when mounted_on referenced a page absent from the sitemap. */
  missing: boolean;
}

export interface ResolvedCapability {
  capability: Capability;
  reach: ReachPath[];
  /** code_anchor or null — each frontend supplies its own "(none)" fallback text. */
  anchor: string | null;
  /** Present only on search results. */
  score?: number;
}

/**
 * Relevance score for a capability against a search term.
 * Weights are load-bearing (CLI ordering depends on them): name 100, id 40,
 * object 30, statement 20, operations 15; deprecated −50, unknown −5.
 */
export function scoreCapability(c: Capability, text: string): number {
  const q = text.toLowerCase();
  let score = 0;
  if (c.name.toLowerCase().includes(q)) score += 100;
  if (c.id.toLowerCase().includes(q)) score += 40;
  if (c.object.some((o) => o.toLowerCase().includes(q))) score += 30;
  if (c.statement.toLowerCase().includes(q)) score += 20;
  if ((c.operations ?? []).some((r) => r.toLowerCase().includes(q))) score += 15;
  if (c.status === "deprecated") score -= 50;
  if (c.status === "unknown") score -= 5;
  return score;
}

/** Matches sorted by descending score; only score > 0. */
export function searchCapabilities(caps: Capability[], text: string): ScoredCapability[] {
  return caps
    .map((capability) => ({ capability, score: scoreCapability(capability, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Reach paths for a capability's mounts against the sitemap. */
export function resolveReach(sitemap: Sitemap, cap: Capability): ReachPath[] {
  return cap.mounted_on.map((pageId) => {
    const path = pagePath(sitemap, pageId);
    return {
      pageId,
      path,
      display: path.map((p) => p.name).join("  ›  "),
      missing: path.length === 0,
    };
  });
}

/** One capability → structured result (capability + reach + anchor). */
export function resolveCapability(sitemap: Sitemap, cap: Capability): ResolvedCapability {
  return { capability: cap, reach: resolveReach(sitemap, cap), anchor: cap.code_anchor ?? null };
}

/** Look up a capability by exact id. */
export function capabilityById(caps: Capability[], id: string): Capability | undefined {
  return caps.find((c) => c.id === id);
}

/** Search + resolve in one call — the MCP `find_capability` backbone. */
export function findCapabilities(caps: Capability[], sitemap: Sitemap, text: string): ResolvedCapability[] {
  return searchCapabilities(caps, text).map(({ capability, score }) => ({
    ...resolveCapability(sitemap, capability),
    score,
  }));
}
