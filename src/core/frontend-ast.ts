import path from "node:path";
import { Project, Node, ts } from "ts-morph";
import { walkFiles } from "./fs-utils.js";
import { pageId as toPageId } from "./util.js";

/**
 * Shared frontend-AST machinery used by every source's usage scanner. One
 * GraphQL/REST/tRPC call simultaneously proves a capability is real, gives its
 * UI anchor (the page), and establishes the mount — so each source matches
 * call-sites its own way, but the page/component derivation, project setup, and
 * collection are common and live here.
 *
 * Best-effort, always: a source resolves only high-confidence sites and reports
 * the rest as UNRESOLVED (a held blind spot) rather than forcing a wrong guess.
 */

/** A high-confidence operation → page link (a mount). */
export interface CallSite {
  /** The matched Operation.name. */
  operation: string;
  kind: string;
  pageId: string;
  pageName: string;
  file: string;
}

/** A call we refused to resolve — held, not concluded. */
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

export interface UsageResult {
  sites: CallSite[];
  unresolved: UnresolvedSite[];
  pages: DiscoveredPage[];
}

export const FRONTEND_FILE_RE = /\.(tsx?|jsx?|mts|cts)$/;

/** A ts-morph project over the frontend, parsing syntactically (no type-check). */
export function createFrontendProject(root: string): Project {
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
    filter: (p) => FRONTEND_FILE_RE.test(p) && !p.endsWith(".d.ts"),
  });
  for (const f of files) {
    try {
      project.addSourceFileAtPathIfExists(f);
    } catch {
      /* unparseable file — skip, never jam the pipeline */
    }
  }
  return project;
}

/** Nearest enclosing named component/function, preferring component-looking names. */
export function enclosingComponentName(node: Node): string | undefined {
  let cur: Node | undefined = node.getParent();
  let fallback: string | undefined;
  while (cur) {
    if (Node.isFunctionDeclaration(cur)) {
      const n = cur.getName();
      if (n) {
        if (isComponentName(n)) return n;
        fallback ??= n;
      }
    } else if (Node.isVariableDeclaration(cur)) {
      const init = cur.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const n = cur.getName();
        if (isComponentName(n)) return n;
        fallback ??= n;
      }
    }
    cur = cur.getParent();
  }
  return fallback;
}

export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name); // PascalCase ≈ React component
}

export function basenameComponent(filePath: string): string {
  const base = path.basename(filePath).replace(FRONTEND_FILE_RE, "");
  return base === "index" ? path.basename(path.dirname(filePath)) : base;
}

/** Derive the page that a call-site sits in. */
export function pageFor(node: Node, filePath: string, projectRoot: string): DiscoveredPage {
  const name = enclosingComponentName(node) ?? basenameComponent(filePath);
  return { id: toPageId(name), name, file: path.relative(projectRoot, filePath) };
}

export function snippetOf(node: Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

/** Accumulates de-duplicated sites/pages/unresolved into a UsageResult. */
export class UsageCollector {
  private sites: CallSite[] = [];
  private unresolved: UnresolvedSite[] = [];
  private pages = new Map<string, DiscoveredPage>();
  private seen = new Set<string>();

  addSite(operation: string, kind: string, page: DiscoveredPage): void {
    const key = `${operation}|${page.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pages.set(page.id, page);
    this.sites.push({ operation, kind, pageId: page.id, pageName: page.name, file: page.file });
  }

  addUnresolved(filePath: string, projectRoot: string, reason: string, node: Node): void {
    this.unresolved.push({ file: path.relative(projectRoot, filePath), reason, snippet: snippetOf(node) });
  }

  result(): UsageResult {
    return {
      sites: this.sites.sort((a, b) => a.operation.localeCompare(b.operation)),
      unresolved: this.unresolved,
      pages: [...this.pages.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
}

/**
 * Turn a string-literal / template-literal node into a static path pattern.
 * Template substitutions (`${id}`) become a `*` wildcard segment. Returns the
 * pattern, or null when the node isn't a usable static-ish string (e.g. a bare
 * identifier or a call). Used by REST/route sources to match URLs to paths.
 */
export function staticPathPattern(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isTemplateExpression(node)) {
    let out = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      out += "*"; // a runtime-interpolated segment
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  return null;
}
