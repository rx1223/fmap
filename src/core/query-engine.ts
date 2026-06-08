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
  let score = 0;
  if (fieldMatches(c.name, text)) score += 100;
  if (fieldMatches(c.id, text)) score += 40;
  if (c.object.some((o) => fieldMatches(o, text))) score += 30;
  if (fieldMatches(c.statement, text)) score += 20;
  if ((c.operations ?? []).some((r) => fieldMatches(r, text))) score += 15;
  if (c.status === "deprecated") score -= 50;
  if (c.status === "unknown") score -= 5;
  return score;
}

/**
 * Match a query against a field. An ASCII query matches only at a WORD BOUNDARY
 * (so "ai" doesn't match "em·ai·l"); camelCase is split first so "email" still
 * matches "verifyEmail". A non-ASCII query (e.g. CJK — no word boundaries) falls
 * back to substring, which is the natural behaviour there.
 */
function fieldMatches(field: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const normalized = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if ([...q].some((ch) => ch.charCodeAt(0) > 127)) return normalized.includes(q); // non-ASCII (e.g. CJK) -> substring
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(q)}`).test(normalized); // ASCII → word-start
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
