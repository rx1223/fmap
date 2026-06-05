import fs from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import { Kind, parse, type FieldNode } from "graphql";
import {
  loadSchema,
  introspectResolvers,
  type GraphqlSchemaConfig,
} from "../introspect.js";
import { walkFiles, fileExists } from "../fs-utils.js";
import {
  createFrontendProject,
  pageFor,
  UsageCollector,
  type UsageResult,
} from "../frontend-ast.js";
import type { Operation } from "../operation.js";
import type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/**
 * GraphQL capability source. Operations come from introspection; the frontend
 * usage scan recognises `useQuery`/`useMutation`/… and `client.query/mutate`,
 * resolving named gql consts (per-file then global) and inline templates.
 */

// GraphQL-/Relay-specific noise. (Cross-protocol noise like health/ping is
// filtered generically by the classifier.)
const GRAPHQL_NOISE = new Set(["node", "nodes", "__typename", "__schema", "__type", "_entities", "_service"]);

const HOOK_NAMES = new Set([
  "useQuery",
  "useLazyQuery",
  "useSuspenseQuery",
  "useBackgroundQuery",
  "useReadQuery",
  "useMutation",
  "useSubscription",
]);
const CLIENT_METHODS = new Set(["query", "mutate", "watchQuery", "subscribe"]);
const GQL_TAGS = new Set(["gql", "graphql"]);

function asSchemaConfig(cfg: SourceConfig): GraphqlSchemaConfig {
  return {
    sdlPath: cfg.sdlPath as string | undefined,
    endpoint: cfg.endpoint as string | undefined,
    headers: cfg.headers as Record<string, string> | undefined,
  };
}

export const graphqlSource: CapabilitySource = {
  id: "graphql",
  title: "GraphQL",

  detect(projectRoot: string): DetectionResult | null {
    const sdlPath = detectSdlPath(projectRoot);
    const endpoint = detectEndpoint(projectRoot);
    if (!sdlPath && !endpoint) return null;
    const config: SourceConfig = { type: "graphql" };
    if (sdlPath) config.sdlPath = sdlPath;
    else if (endpoint) config.endpoint = endpoint;
    return { config, summary: `GraphQL (${sdlPath ?? `endpoint ${endpoint}`})` };
  },

  async loadOperations(cfg: SourceConfig, projectRoot: string): Promise<Operation[]> {
    const schema = await loadSchema(asSchemaConfig(cfg), projectRoot);
    return introspectResolvers(schema).map((r) => ({
      sourceId: "graphql",
      name: r.name,
      kind: r.kind,
      entities: r.objectTypes,
      description: r.description,
      deprecated: r.deprecated,
      noise: GRAPHQL_NOISE.has(r.name),
    }));
  },

  scanUsage(_ops: Operation[], frontendRoot: string, projectRoot: string): UsageResult {
    return scanGraphqlUsage(frontendRoot, projectRoot);
  },
};

// ── Detection helpers ───────────────────────────────────────────────────────

function detectSdlPath(cwd: string): string | undefined {
  for (const name of ["schema.graphql", "schema.gql", "schema.graphqls"]) {
    if (fileExists(path.join(cwd, name))) return name;
  }
  const files = walkFiles(cwd, { filter: (p) => /\.(graphql|gql|graphqls)$/i.test(p), limit: 200 });
  if (!files.length) return undefined;
  let best = files[0];
  let bestSize = 0;
  for (const f of files) {
    try {
      const size = fs.statSync(f).size;
      if (size > bestSize) {
        bestSize = size;
        best = f;
      }
    } catch {
      /* ignore */
    }
  }
  return path.relative(cwd, best);
}

function detectEndpoint(cwd: string): string | undefined {
  for (const name of ["codegen.yml", "codegen.yaml", ".graphqlrc", ".graphqlrc.yml", ".graphqlrc.yaml"]) {
    const p = path.join(cwd, name);
    if (!fileExists(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/https?:\/\/[^\s"'`]+/);
    if (m) return m[0];
  }
  return undefined;
}

// ── Usage scan (best-effort, UNKNOWN-aware) ─────────────────────────────────

interface ParsedOps {
  ops: { kind: string; resolvers: string[] }[];
}

function scanGraphqlUsage(frontendRoot: string, projectRoot: string): UsageResult {
  const project = createFrontendProject(frontendRoot);
  const collector = new UsageCollector();

  // Pass 1: gql const name → parsed operations (per-file + global).
  const localMaps = new Map<string, Map<string, ParsedOps>>();
  const globalMap = new Map<string, { ops: ParsedOps; file: string }[]>();
  for (const sf of project.getSourceFiles()) {
    const fileMap = new Map<string, ParsedOps>();
    for (const vd of sf.getVariableDeclarations()) {
      const init = vd.getInitializer();
      if (!init || !Node.isTaggedTemplateExpression(init)) continue;
      if (!isGqlTag(init.getTag().getText())) continue;
      const tmpl = init.getTemplate();
      if (!Node.isNoSubstitutionTemplateLiteral(tmpl)) continue;
      const parsed = parseGqlOperations(tmpl.getLiteralText());
      if (!parsed) continue;
      fileMap.set(vd.getName(), parsed);
    }
    localMaps.set(sf.getFilePath(), fileMap);
    for (const [name, ops] of fileMap) {
      const list = globalMap.get(name) ?? [];
      list.push({ ops, file: sf.getFilePath() });
      globalMap.set(name, list);
    }
  }

  // Pass 2: resolve call-sites.
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const arg = graphqlArgOf(call);
      if (!arg) continue;
      const page = pageFor(call, filePath, projectRoot);
      const resolved = resolveArg(arg, filePath, localMaps, globalMap);
      if (!resolved.ok) {
        collector.addUnresolved(filePath, projectRoot, resolved.reason, call);
        continue;
      }
      for (const op of resolved.ops.ops) {
        for (const resolver of op.resolvers) collector.addSite(resolver, op.kind, page);
      }
    }
  }

  return collector.result();
}

function isGqlTag(tagText: string): boolean {
  const seg = tagText.split(".").pop() ?? tagText;
  return GQL_TAGS.has(seg);
}

function parseGqlOperations(text: string): ParsedOps | null {
  let doc;
  try {
    doc = parse(text);
  } catch {
    return null;
  }
  const ops: ParsedOps["ops"] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const resolvers = def.selectionSet.selections
      .filter((s): s is FieldNode => s.kind === Kind.FIELD)
      .map((s) => s.name.value)
      .filter((n) => n !== "__typename");
    if (resolvers.length) ops.push({ kind: def.operation, resolvers });
  }
  return ops.length ? { ops } : null;
}

function graphqlArgOf(call: Node): Node | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const calleeName = Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : Node.isIdentifier(callee)
      ? callee.getText()
      : "";
  const args = call.getArguments();
  if (HOOK_NAMES.has(calleeName)) return args[0];
  if (CLIENT_METHODS.has(calleeName) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    for (const prop of ["query", "mutation", "document"]) {
      const p = args[0].getProperty(prop);
      if (p && Node.isPropertyAssignment(p)) {
        const init = p.getInitializer();
        if (init) return init;
      }
    }
  }
  return undefined;
}

type ResolveOutcome = { ok: true; ops: ParsedOps } | { ok: false; reason: string };

function resolveArg(
  arg: Node,
  filePath: string,
  localMaps: Map<string, Map<string, ParsedOps>>,
  globalMap: Map<string, { ops: ParsedOps; file: string }[]>,
): ResolveOutcome {
  if (Node.isTaggedTemplateExpression(arg)) {
    if (!isGqlTag(arg.getTag().getText())) return { ok: false, reason: "non-gql tagged template argument" };
    const tmpl = arg.getTemplate();
    if (!Node.isNoSubstitutionTemplateLiteral(tmpl)) {
      return { ok: false, reason: "interpolated gql template (runtime-composed)" };
    }
    const parsed = parseGqlOperations(tmpl.getLiteralText());
    return parsed ? { ok: true, ops: parsed } : { ok: false, reason: "unparseable inline gql" };
  }
  if (Node.isIdentifier(arg)) {
    const name = arg.getText();
    const local = localMaps.get(filePath)?.get(name);
    if (local) return { ok: true, ops: local };
    const global = globalMap.get(name);
    if (global && global.length === 1) return { ok: true, ops: global[0].ops };
    if (global && global.length > 1) {
      return { ok: false, reason: `query const "${name}" is ambiguous across ${global.length} files` };
    }
    return { ok: false, reason: `query const "${name}" is not a static gql template in scope` };
  }
  return { ok: false, reason: `dynamic query argument (${arg.getKindName()})` };
}
