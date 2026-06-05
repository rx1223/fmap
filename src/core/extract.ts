import type { ResolverInfo } from "./introspect.js";
import type { ScanResult } from "./scan-frontend.js";
import type { ProjectConfig } from "../config/project.js";
import type { LlmProvider } from "../providers/provider.js";
import type { Capability } from "./model.js";
import { classify, type ClassifiedResolver, type Quadrant } from "./classify.js";
import { capabilityId, extractJson, unique } from "./util.js";
import { moduleSlug } from "./yaml-store.js";

/**
 * M3 — the semantic step. The ONLY part that needs an LLM, and the only part an
 * operator must back. The LLM re-slices resolvers into capabilities and writes
 * the human name + falsifiable statement. Everything else — status, mounts,
 * object tags — is computed deterministically from the classification so the
 * model can't invent provenance. All output is `status: pending` (or `unknown`)
 * and `source: introspection`; only a human ever writes `approved`.
 */

/** A capability plus the module that decides which file it lands in (not persisted in the body). */
export interface DraftCapability extends Capability {
  module: string;
}

export interface ExtractInput {
  resolvers: ResolverInfo[];
  scan: ScanResult;
  config: ProjectConfig;
  provider: LlmProvider;
}

/** What the LLM is asked to return — grouping + prose only. */
interface LlmCapability {
  id?: string;
  name: string;
  statement: string;
  module: string;
  resolvers: string[];
}

export async function extractCapabilities(input: ExtractInput): Promise<DraftCapability[]> {
  const classified = classify(input.resolvers, input.scan);
  const byName = new Map(classified.map((c) => [c.resolver.name, c]));

  const candidates = classified.filter((c) => {
    if (c.quadrant === "noise") return false;
    if (c.quadrant === "no_entry" && input.config.strategy.opsOnlyCapabilities === "exclude") return false;
    return true;
  });
  if (candidates.length === 0) return [];

  const llmCaps = await runSemanticStep(candidates, input.config, input.provider);
  return assembleCapabilities(llmCaps, byName, input.scan);
}

// ── The LLM call ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You turn a GraphQL resolver inventory into a list of USER-PERCEIVABLE CAPABILITIES.

A capability = the thing a user would name when asking for help ("view store revenue", "buy a trial card") — NOT a button, NOT a raw resolver.

Your job (the only part a machine cannot do):
1. RE-SLICE resolvers by business meaning. resolver != capability:
   - MERGE several resolvers that serve ONE user goal into one capability
     (e.g. todayRevenue + revenueByRange + revenueBreakdown = "view store revenue").
   - SPLIT one resolver that bundles several user actions into multiple capabilities
     (e.g. updateMembershipCard(action) -> "renew card", "upgrade card", "replace card");
     emit one capability per action, each referencing that same resolver.
2. DROP residual noise: resolvers no user would ask about (internal plumbing, debug,
   deprecated-and-replaced). Obvious mechanical noise is already removed.
3. NAME each capability the way a user would say it (short phrase).
4. Write a FALSIFIABLE statement: verb + object + location, one sentence an operator can
   tick off. Use the page name(s) given as the location. NEVER write rules, limits, counts,
   thresholds or implementation — the map stores WHERE, not HOW.
5. Assign a kebab-case business MODULE (store-finance, membership-card, user, auth, ...) to
   group capabilities into files.

Output a STRICT JSON array and nothing else. Each element:
{ "id": "<short_snake_case_english_id>", "name": "<user-facing name>", "statement": "<falsifiable sentence>", "module": "<kebab-module>", "resolvers": ["<resolverName>", ...] }

Rules:
- Use ONLY resolver names from the input. Never invent resolvers.
- A resolver may appear in multiple capabilities (when split). Every capability needs >= 1 input resolver.
- The statement must be checkable and must NOT contain business-rule numbers.`;

async function runSemanticStep(
  candidates: ClassifiedResolver[],
  config: ProjectConfig,
  provider: LlmProvider,
): Promise<LlmCapability[]> {
  const items = candidates.map((c) => ({
    name: c.resolver.name,
    kind: c.resolver.kind,
    types: c.resolver.objectTypes,
    description: c.resolver.description ?? undefined,
    deprecated: c.resolver.deprecated || undefined,
    entry: entryLabel(c.quadrant),
    pages: c.pages.map((p) => p.name),
  }));

  const user =
    `Granularity preference: ${config.strategy.granularity} ` +
    `(coarse = prefer merging, keep bundled mutations as one capability unless clearly several user actions; ` +
    `fine = split aggressively).\n\n` +
    `Candidate resolvers. "entry":"frontend" = called from the listed pages (its UI location); ` +
    `"entry":"none" = no UI entry found (likely a backend/ops capability — still include it, with empty location); ` +
    `"entry":"unknown" = the scanner could not tell.\n\n` +
    JSON.stringify(items, null, 2) +
    `\n\nReturn the capability JSON array.`;

  const raw = await provider.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
    maxTokens: 8192,
    temperature: 0,
  });

  const parsed = extractJson<LlmCapability[]>(raw);
  if (!Array.isArray(parsed)) throw new Error("LLM did not return a JSON array of capabilities.");
  return parsed.filter((c) => c && typeof c.name === "string" && Array.isArray(c.resolvers));
}

function entryLabel(q: Quadrant): "frontend" | "none" | "unknown" {
  if (q === "user_capability") return "frontend";
  if (q === "unknown") return "unknown";
  return "none"; // no_entry
}

// ── Deterministic assembly ───────────────────────────────────────────────────

function assembleCapabilities(
  llmCaps: LlmCapability[],
  byName: Map<string, ClassifiedResolver>,
  scan: ScanResult,
): DraftCapability[] {
  const pagesByResolver = new Map<string, { id: string; name: string }[]>();
  for (const site of scan.sites) {
    const arr = pagesByResolver.get(site.resolver) ?? [];
    arr.push({ id: site.pageId, name: site.pageName });
    pagesByResolver.set(site.resolver, arr);
  }

  const usedIds = new Set<string>();
  const out: DraftCapability[] = [];
  const coveredCalled = new Set<string>();

  for (const cap of llmCaps) {
    const resolvers = unique(cap.resolvers.filter((r) => byName.has(r)));
    if (resolvers.length === 0) continue; // hallucinated / empty — drop

    const draft = buildDraft(cap.id, cap.name, cap.statement, cap.module, resolvers, byName, pagesByResolver, usedIds);
    out.push(draft);
    for (const r of resolvers) {
      if (byName.get(r)?.quadrant === "user_capability") coveredCalled.add(r);
    }
  }

  // Safety net: a CALLED resolver (proven reachable in the UI) must never be
  // silently dropped by the LLM. Emit a fallback capability for any it missed.
  for (const [name, c] of byName) {
    if (c.quadrant !== "user_capability" || coveredCalled.has(name)) continue;
    const draft = buildDraft(
      undefined,
      name,
      `Reachable via ${c.pages.map((p) => p.name).join(", ") || "the UI"} (uncategorised — review).`,
      "misc",
      [name],
      byName,
      pagesByResolver,
      usedIds,
    );
    out.push(draft);
  }

  return out;
}

function buildDraft(
  rawId: string | undefined,
  name: string,
  statement: string,
  module: string,
  resolvers: string[],
  byName: Map<string, ClassifiedResolver>,
  pagesByResolver: Map<string, { id: string; name: string }[]>,
  usedIds: Set<string>,
): DraftCapability {
  const object = unique(resolvers.flatMap((r) => byName.get(r)?.resolver.objectTypes ?? []));
  const pageList = unique(resolvers.flatMap((r) => (pagesByResolver.get(r) ?? []).map((p) => p.id)));
  const hasCall = pageList.length > 0;
  const anyUnknown = resolvers.some((r) => byName.get(r)?.quadrant === "unknown");
  // called -> pending (with mounts); else unknown -> unknown; else no_entry -> pending (empty mounts)
  const status: Capability["status"] = hasCall ? "pending" : anyUnknown ? "unknown" : "pending";

  return {
    id: ensureUniqueId(rawId, name, usedIds),
    name,
    statement,
    object,
    mounted_on: pageList,
    resolvers: [...resolvers].sort(),
    status,
    source: "introspection",
    module: moduleSlug(module),
  };
}

function ensureUniqueId(rawId: string | undefined, name: string, used: Set<string>): string {
  let base = rawId && rawId.trim() ? rawId.trim() : "";
  if (!base) base = capabilityId(name); // -> "cap.<slug>"
  if (!base.startsWith("cap.")) base = `cap.${base.replace(/^cap\.?/, "")}`;
  base = base.replace(/[^\p{L}\p{N}_.]/gu, "_");
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

/** Group drafts into module → Capability[] for the YAML store. */
export function groupByModule(drafts: DraftCapability[]): Map<string, Capability[]> {
  const groups = new Map<string, Capability[]>();
  for (const d of drafts) {
    const { module, ...cap } = d;
    const list = groups.get(module) ?? [];
    list.push(cap);
    groups.set(module, list);
  }
  return groups;
}
