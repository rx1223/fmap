import type { Capability, CapabilityStatus } from "./model.js";
import { unique } from "./util.js";

/**
 * M4 — idempotent reconcile. THE make-or-break module: a second `build` that
 * clobbers operator edits makes the tool single-use.
 *
 * Matched by id:
 *   - new id            → added as the machine drafted it (pending/unknown)
 *   - existing id       → human fields (name, statement, status) PRESERVED;
 *                         machine fields (object, resolvers, code_anchor)
 *                         refreshed; mounted_on union-merged so manual mount
 *                         fixes survive; source kept as original provenance
 *   - gone-from-code    → marked `deprecated`, NEVER hard-deleted
 *
 * The one machine-driven status change allowed: `unknown` → `pending` when a
 * call-site has since appeared. `unknown` is a machine "couldn't tell" state,
 * not a human verdict — new evidence resolves it (still pending, still needs a
 * human to approve). A human-chosen status (approved/pending/deprecated) is
 * never auto-changed in the merge branch.
 */

export interface ReconcileResult {
  caps: Capability[];
  added: string[];
  updated: string[];
  unchanged: string[];
  deprecated: string[];
}

export function reconcile(existing: Capability[], drafts: Capability[]): ReconcileResult {
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const draftById = new Map(drafts.map((c) => [c.id, c]));

  const caps: Capability[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const deprecated: string[] = [];

  // 1) Walk drafts: add brand-new, merge existing.
  for (const draft of drafts) {
    const prior = existingById.get(draft.id);
    if (!prior) {
      caps.push(normalize(draft));
      added.push(draft.id);
      continue;
    }
    const merged = mergeExisting(prior, draft);
    caps.push(merged);
    if (sameCapability(prior, merged)) unchanged.push(draft.id);
    else updated.push(draft.id);
  }

  // 2) Walk existing not present in drafts: deprecate, never delete.
  for (const prior of existing) {
    if (draftById.has(prior.id)) continue;
    if (prior.status === "deprecated") {
      caps.push(normalize(prior)); // already deprecated — keep as-is
      unchanged.push(prior.id);
    } else {
      caps.push(normalize({ ...prior, status: "deprecated" }));
      deprecated.push(prior.id);
    }
  }

  return { caps, added, updated, unchanged, deprecated };
}

/** Merge a freshly-drafted capability into its existing (human-touched) row. */
export function mergeExisting(existing: Capability, draft: Capability): Capability {
  const draftHasCall = (draft.mounted_on?.length ?? 0) > 0;
  const status: CapabilityStatus =
    existing.status === "unknown" && draftHasCall ? "pending" : existing.status;

  return normalize({
    id: existing.id,
    // human-owned — preserved verbatim
    name: existing.name,
    statement: existing.statement,
    status,
    // machine-owned — refreshed from code
    object: draft.object ?? [],
    resolvers: draft.resolvers ?? [],
    // don't erase a human/ops-supplied anchor when the machine has none
    code_anchor: draft.code_anchor ?? existing.code_anchor,
    // union so a manually-added mount survives a rebuild
    mounted_on: mergeMounts(existing.mounted_on, draft.mounted_on),
    // provenance reflects original discovery
    source: existing.source,
  });
}

function mergeMounts(existing: string[] = [], draft: string[] = []): string[] {
  return unique([...existing, ...draft]).sort();
}

/** Stable shape + sorted arrays so YAML diffs are minimal and comparison is reliable. */
function normalize(c: Capability): Capability {
  const out: Capability = {
    id: c.id,
    name: c.name,
    statement: c.statement,
    object: [...(c.object ?? [])].sort(),
    mounted_on: [...(c.mounted_on ?? [])].sort(),
    status: c.status,
    source: c.source,
  };
  if (c.code_anchor) out.code_anchor = c.code_anchor;
  const resolvers = c.resolvers ? [...c.resolvers].sort() : [];
  if (resolvers.length) out.resolvers = resolvers;
  return out;
}

function sameCapability(a: Capability, b: Capability): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
