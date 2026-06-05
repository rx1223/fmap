/**
 * The data model — three decoupled collections.
 *
 *   1. Capabilities — a user-perceivable thing one can do. Each is a falsifiable
 *      statement (verb + object + location). Split by business module.
 *   2. Sitemap — page nodes + transitions + entity hubs. A graph, one file.
 *   3. Mounts — which page(s) expose which capability (Capability.mounted_on).
 *
 * The map stores WHERE, not HOW. It never records implementation or business
 * rules — those live in code, reached via `code_anchor`. This is why it does
 * not rot: "where the feature lives" changes rarely.
 */

/** The four-quadrant state a capability can be in. */
export type CapabilityStatus =
  | "approved" // a human verified it — the only status a human writes
  | "pending" // machine-extracted, awaiting human approval (the default for all output)
  | "unknown" // scanner couldn't tell (scatter blind spot) — held, not concluded
  | "deprecated"; // gone from code — never hard-deleted, marked instead

/** How a capability entered the map (for audit). */
export type CapabilitySource =
  | "introspection" // GraphQL schema (automatic)
  | "ops" // operator added by hand
  | "user_question" // discovered by a user's question at runtime (self-growth)
  | "code_pr"; // rode in on a code PR

export interface Capability {
  /** Stable id, e.g. "cap.purchase_trial_card". */
  id: string;
  /** The name a user would say when asking for help, e.g. "购买体验卡". */
  name: string;
  /** Falsifiable: verb + object + location, so an operator can tick it off. */
  statement: string;
  /** Operation objects — the chaining backbone, often from GraphQL types. */
  object: string[];
  /** Page ids that expose this capability. Structured, NOT md links. */
  mounted_on: string[];
  /** "src/services/card.ts#purchaseTrialCard" — the ONLY locator for side-effect caps. */
  code_anchor?: string;
  /** Underlying GraphQL operations this capability is sliced from. */
  resolvers?: string[];
  status: CapabilityStatus;
  source: CapabilitySource;
}

export interface PageNode {
  /** Stable id, e.g. "page.store_finance". */
  id: string;
  /** Human name, e.g. "店铺财务信息". */
  name: string;
  /** Route pattern, e.g. "/stores/:id/finance". */
  route?: string;
  /** Parent page id — the tree edge is implied here, NOT stored as a transition. */
  parent?: string | null;
  /** If set, this page is the detail hub for that entity type (e.g. "User"). */
  entityHub?: string;
}

/** ONLY special (non-tree, non-entity-hub) cross-jumps are stored explicitly. */
export interface Transition {
  from: string;
  to: string;
  note?: string;
}

export interface Sitemap {
  pages: PageNode[];
  transitions: Transition[];
}

/** One capabilities/<module>.yaml file: a flat list of capabilities. */
export type CapabilityFile = Capability[];

/**
 * Fields a human owns — reconcile must NEVER clobber these on re-build.
 * These are the human's prose and verdict; the machine only ever proposes them
 * for brand-new rows.
 */
export const HUMAN_OWNED_FIELDS = ["name", "statement", "status"] as const;

/**
 * Fields the machine owns — reconcile refreshes these from code each build.
 * `object` is re-derived from GraphQL types; `resolvers`/`code_anchor` are
 * re-located. `mounted_on` is special: refreshed from call-sites but
 * union-merged with the existing value so manual mount fixes survive
 * (see reconcile.ts). `source` is preserved as original provenance.
 */
export const MACHINE_OWNED_FIELDS = [
  "code_anchor",
  "resolvers",
  "object",
] as const;
