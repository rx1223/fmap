import fs from "node:fs";
import path from "node:path";
import {
  buildSchema,
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isObjectType,
  isInputObjectType,
  isInterfaceType,
  isUnionType,
  isIntrospectionType,
  type GraphQLSchema,
  type GraphQLObjectType,
  type GraphQLField,
  type GraphQLNamedType,
  type IntrospectionQuery,
} from "graphql";
import type { ProjectConfig } from "../config/project.js";

/**
 * M1 — deterministic, no LLM. Turn a GraphQL schema (live endpoint or local
 * SDL) into a flat resolver list. introspection gives a "resolver list", not a
 * "capability list" — the semantic re-slicing happens later (M3) with the LLM.
 */

export type ResolverKind = "query" | "mutation";

export interface ResolverInfo {
  /** The field name, e.g. "todayRevenue", "createUser". */
  name: string;
  kind: ResolverKind;
  /** Composite type names referenced by the return + args — chaining backbone. */
  objectTypes: string[];
  /** Schema description, if any — useful context for the semantic step. */
  description?: string;
  /** Carries a deprecation reason in the schema — a strong hint it is dead/noise. */
  deprecated: boolean;
}

/** Resolve the schema from config: SDL file takes precedence, else live endpoint. */
export async function loadSchema(
  cfg: ProjectConfig,
  projectRoot: string = process.cwd(),
): Promise<GraphQLSchema> {
  if (cfg.schema.sdlPath) {
    const p = path.isAbsolute(cfg.schema.sdlPath)
      ? cfg.schema.sdlPath
      : path.join(projectRoot, cfg.schema.sdlPath);
    if (!fs.existsSync(p)) {
      throw new Error(`SDL file not found: ${p}\n  → Fix schema.sdlPath in feature-map.config.yaml.`);
    }
    return buildSchema(fs.readFileSync(p, "utf8"));
  }
  if (cfg.schema.endpoint) {
    return introspectEndpoint(cfg.schema.endpoint, cfg.schema.headers ?? {});
  }
  throw new Error(
    "No schema source configured.\n  → Set schema.sdlPath or schema.endpoint in feature-map.config.yaml.",
  );
}

async function introspectEndpoint(
  endpoint: string,
  headerEnvMap: Record<string, string>,
): Promise<GraphQLSchema> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Header VALUES come from env-var NAMES in config — never literal secrets.
  for (const [headerName, envVar] of Object.entries(headerEnvMap)) {
    const val = process.env[envVar];
    if (val && val.trim()) headers[headerName] = val.trim();
    else console.warn(`Warning: header "${headerName}" → env var ${envVar} is unset; sending without it.`);
  }
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
  } catch (e) {
    throw new Error(`Could not reach GraphQL endpoint ${endpoint}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Introspection request to ${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: IntrospectionQuery; errors?: unknown };
  if (json.errors) {
    throw new Error(`Introspection returned errors: ${JSON.stringify(json.errors)}`);
  }
  if (!json.data) throw new Error("Introspection returned no data.");
  return buildClientSchema(json.data);
}

/** Pure: schema → resolver list. Every query and mutation field becomes one entry. */
export function introspectResolvers(schema: GraphQLSchema): ResolverInfo[] {
  const out: ResolverInfo[] = [];
  const q = schema.getQueryType();
  const m = schema.getMutationType();
  if (q) out.push(...fieldsToResolvers(q, "query"));
  if (m) out.push(...fieldsToResolvers(m, "mutation"));
  return out;
}

function fieldsToResolvers(type: GraphQLObjectType, kind: ResolverKind): ResolverInfo[] {
  return Object.values(type.getFields()).map((field) => ({
    name: field.name,
    kind,
    objectTypes: collectObjectTypes(field),
    description: field.description ?? undefined,
    deprecated: !!field.deprecationReason,
  }));
}

/** Distinct composite (non-scalar, non-enum, non-introspection) type names. */
function collectObjectTypes(field: GraphQLField<unknown, unknown>): string[] {
  const names = new Set<string>();
  const add = (t: GraphQLNamedType) => {
    if (isIntrospectionType(t)) return;
    if (isObjectType(t) || isInputObjectType(t) || isInterfaceType(t) || isUnionType(t)) {
      names.add(t.name);
    }
  };
  add(getNamedType(field.type));
  for (const arg of field.args) add(getNamedType(arg.type));
  return [...names].sort();
}

/** Object type names (excluding root operation types) — feeds entity-hub detection. */
export function coreObjectTypes(schema: GraphQLSchema): string[] {
  const roots = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter(Boolean)
      .map((t) => t!.name),
  );
  return Object.values(schema.getTypeMap())
    .filter((t): t is GraphQLObjectType => isObjectType(t) && !isIntrospectionType(t))
    .map((t) => t.name)
    .filter((n) => !roots.has(n))
    .sort();
}

/** Convenience: load + extract in one call. */
export async function introspect(
  cfg: ProjectConfig,
  projectRoot: string = process.cwd(),
): Promise<ResolverInfo[]> {
  return introspectResolvers(await loadSchema(cfg, projectRoot));
}
