/**
 * The generic capability-candidate unit. A `CapabilitySource` (GraphQL, REST,
 * tRPC, route handlers, …) turns a project's backend surface into a list of
 * these. The rest of the pipeline (classify → LLM re-slice → reconcile) is
 * source-agnostic: it only ever sees Operations, never a protocol.
 */
export interface Operation {
  /** Which source produced this, e.g. "graphql" | "openapi" | "trpc" | "route". */
  sourceId: string;
  /** Operation identifier within its source: "todayRevenue", "GET /stores/{id}", "store.revenue". */
  name: string;
  /** Source-specific kind: "query" | "mutation" | "GET" | "POST" | "procedure" | … */
  kind: string;
  /** Entity/type names involved — chaining backbone + entity-hub detection. */
  entities: string[];
  /** Description from the source (schema doc, OpenAPI summary), if any. */
  description?: string;
  /** Deprecated upstream — a strong dead/noise hint. */
  deprecated?: boolean;
  /** Source-flagged mechanical noise (Relay node, OPTIONS, health, …). */
  noise?: boolean;
  /** Code anchor the source already knows (e.g. a route handler file#fn). */
  anchor?: string;
}
