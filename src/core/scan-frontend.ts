import path from "node:path";
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import { Kind, parse, type FieldNode } from "graphql";
import { walkFiles } from "./fs-utils.js";
import { pageId as toPageId } from "./util.js";

/**
 * M2 — the frontend call-site scan. One GraphQL call (`useQuery(STORE_REVENUE)`)
 * simultaneously proves a capability is real, gives its UI anchor (the page),
 * and establishes the mount. Mounts are NOT hand-authored — they live here.
 *
 * The hard truth: frontend code is messy. Static scanning CANNOT be complete
 * (dynamic names, interpolated templates, deep HOCs). So this scanner is
 * best-effort: it resolves ONLY high-confidence sites and honestly reports the
 * rest as UNRESOLVED — never a forced wrong guess. A weird codebase yields more
 * UNKNOWN, never a crash. The scanner is behind an interface so tree-sitter or
 * another parser can be swapped in.
 */

export type OperationKind = "query" | "mutation" | "subscription";

/** A high-confidence resolver → page link. */
export interface CallSite {
  resolver: string;
  kind: OperationKind;
  /** Provisional page id derived from the enclosing component. */
  pageId: string;
  /** Human-friendly page/component name. */
  pageName: string;
  file: string;
}

/** A call we refused to resolve — held as a blind spot, not concluded. */
export interface UnresolvedSite {
  file: string;
  reason: string;
  snippet: string;
}

export interface DiscoveredPage {
  id: string;
  name: string;
  file: string;
}

export interface ScanResult {
  sites: CallSite[];
  unresolved: UnresolvedSite[];
  pages: DiscoveredPage[];
}

/** Swappable scanner boundary (ts-morph today; tree-sitter etc. later). */
export interface FrontendScanner {
  scan(root: string, projectRoot?: string): ScanResult;
}

const HOOK_NAMES = new Set([
  "useQuery",
  "useLazyQuery",
  "useSuspenseQuery",
  "useBackgroundQuery",
  "useReadQuery",
  "useMutation",
  "useSubscription",
]);
// client.query({ query: X }) / client.mutate({ mutation: X }) style.
const CLIENT_METHODS = new Set(["query", "mutate", "watchQuery", "subscribe"]);
const GQL_TAGS = new Set(["gql", "graphql"]);

interface ParsedOps {
  ops: { kind: OperationKind; resolvers: string[] }[];
}

export class TsMorphScanner implements FrontendScanner {
  scan(root: string, projectRoot: string = process.cwd()): ScanResult {
    const project = new Project({
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.Latest,
        noLib: true,
      },
      skipLoadingLibFiles: true,
      skipFileDependencyResolution: true,
      useInMemoryFileSystem: false,
    });

    const files = walkFiles(root, {
      filter: (p) => /\.(tsx?|jsx?|mts|cts)$/.test(p) && !p.endsWith(".d.ts"),
    });
    for (const f of files) {
      try {
        project.addSourceFileAtPathIfExists(f);
      } catch {
        /* unparseable file — skip, never jam the pipeline */
      }
    }

    // Pass 1: map gql const names → parsed operations (per-file + global).
    const localMaps = new Map<string, Map<string, ParsedOps>>();
    const globalMap = new Map<string, { ops: ParsedOps; file: string }[]>();
    for (const sf of project.getSourceFiles()) {
      const fileMap = new Map<string, ParsedOps>();
      for (const vd of sf.getVariableDeclarations()) {
        const init = vd.getInitializer();
        if (!init || !Node.isTaggedTemplateExpression(init)) continue;
        if (!isGqlTag(init.getTag().getText())) continue;
        const tmpl = init.getTemplate();
        if (!Node.isNoSubstitutionTemplateLiteral(tmpl)) continue; // interpolated → skip
        const parsed = parseGqlOperations(tmpl.getLiteralText());
        if (!parsed) continue;
        const name = vd.getName();
        fileMap.set(name, parsed);
      }
      localMaps.set(sf.getFilePath(), fileMap);
      for (const [name, ops] of fileMap) {
        const list = globalMap.get(name) ?? [];
        list.push({ ops, file: sf.getFilePath() });
        globalMap.set(name, list);
      }
    }

    // Pass 2: resolve call-sites.
    const sites: CallSite[] = [];
    const unresolved: UnresolvedSite[] = [];
    const pages = new Map<string, DiscoveredPage>();
    const seen = new Set<string>();

    for (const sf of project.getSourceFiles()) {
      const filePath = sf.getFilePath();
      const rel = path.relative(projectRoot, filePath);
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const arg = graphqlArgOf(call);
        if (!arg) continue; // not a GraphQL call-site at all

        const comp = enclosingComponent(call) ?? { name: basenameComponent(filePath) };
        const page: DiscoveredPage = {
          id: toPageId(comp.name),
          name: comp.name,
          file: rel,
        };

        const resolved = resolveArg(arg.node, filePath, localMaps, globalMap);
        if (!resolved.ok) {
          unresolved.push({ file: rel, reason: resolved.reason, snippet: snippetOf(call) });
          continue;
        }
        pages.set(page.id, page);
        for (const op of resolved.ops.ops) {
          for (const resolver of op.resolvers) {
            const key = `${resolver}|${page.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sites.push({
              resolver,
              kind: op.kind,
              pageId: page.id,
              pageName: page.name,
              file: rel,
            });
          }
        }
      }
    }

    return {
      sites: sites.sort((a, b) => a.resolver.localeCompare(b.resolver)),
      unresolved,
      pages: [...pages.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
}

let defaultScanner: FrontendScanner | undefined;
export function getScanner(): FrontendScanner {
  return (defaultScanner ??= new TsMorphScanner());
}

// ---------------------------------------------------------------------------

function isGqlTag(tagText: string): boolean {
  // tag may be "gql", "graphql", or "Apollo.gql" etc. — check the last segment.
  const seg = tagText.split(".").pop() ?? tagText;
  return GQL_TAGS.has(seg);
}

/** Parse a gql template's text into its operations + root resolver names. */
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
    if (resolvers.length) ops.push({ kind: def.operation as OperationKind, resolvers });
  }
  return ops.length ? { ops } : null;
}

interface GraphqlArg {
  node: Node;
}

/** If `call` is a recognised GraphQL call-site, return the argument node holding the document. */
function graphqlArgOf(call: Node): GraphqlArg | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const calleeName = Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : Node.isIdentifier(callee)
      ? callee.getText()
      : "";
  const args = call.getArguments();
  if (HOOK_NAMES.has(calleeName)) {
    if (!args[0]) return undefined;
    return { node: args[0] };
  }
  if (CLIENT_METHODS.has(calleeName) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    for (const prop of ["query", "mutation", "document"]) {
      const p = args[0].getProperty(prop);
      if (p && Node.isPropertyAssignment(p)) {
        const init = p.getInitializer();
        if (init) return { node: init };
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
  // Inline gql`...` template.
  if (Node.isTaggedTemplateExpression(arg)) {
    if (!isGqlTag(arg.getTag().getText())) {
      return { ok: false, reason: "non-gql tagged template argument" };
    }
    const tmpl = arg.getTemplate();
    if (!Node.isNoSubstitutionTemplateLiteral(tmpl)) {
      return { ok: false, reason: "interpolated gql template (runtime-composed)" };
    }
    const parsed = parseGqlOperations(tmpl.getLiteralText());
    return parsed ? { ok: true, ops: parsed } : { ok: false, reason: "unparseable inline gql" };
  }
  // Named const reference.
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
  // Anything else: dynamic, conditional, computed → refuse to guess.
  return { ok: false, reason: `dynamic query argument (${arg.getKindName()})` };
}

/** Nearest enclosing named component/function, preferring component-looking names. */
function enclosingComponent(node: Node): { name: string } | undefined {
  let cur: Node | undefined = node.getParent();
  let fallback: string | undefined;
  while (cur) {
    if (Node.isFunctionDeclaration(cur)) {
      const n = cur.getName();
      if (n) {
        if (isComponentName(n)) return { name: n };
        fallback ??= n;
      }
    } else if (Node.isVariableDeclaration(cur)) {
      const init = cur.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const n = cur.getName();
        if (isComponentName(n)) return { name: n };
        fallback ??= n;
      }
    }
    cur = cur.getParent();
  }
  return fallback ? { name: fallback } : undefined;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name); // PascalCase ≈ React component
}

function basenameComponent(filePath: string): string {
  const base = path.basename(filePath).replace(/\.(tsx?|jsx?|mts|cts)$/, "");
  return base === "index" ? path.basename(path.dirname(filePath)) : base;
}

function snippetOf(node: Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}
