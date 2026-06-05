import { Node, SyntaxKind } from "ts-morph";
import { pageId as toPageId } from "./util.js";
import { createFrontendProject, type DiscoveredPage } from "./frontend-ast.js";
import type { PageNode, Sitemap } from "./model.js";

/**
 * M5 — the sitemap (pages + tree + entity hubs + a few special transitions).
 * Pages come from the frontend, NOT GraphQL. This is decoupled from
 * capabilities on purpose: a nav change touches only the sitemap.
 *
 * Best-effort like the call-site scanner: it reads React-Router `<Route>` /
 * route-config forms to recover routes + tree parents, seeds pages from the
 * components that issue GraphQL calls, and marks entity hubs by matching pages
 * to schema core types. Transitions are left to humans (the tier-2 knob is off
 * by default) — the tree is implied by `parent`, hubs by the rule.
 */

interface RouteHit {
  component: string;
  path?: string;
  parentComponent?: string;
}

export interface BuildSitemapInput {
  /** Pages discovered by the sources' usage scans (components issuing calls). */
  pages: DiscoveredPage[];
  /** Entity type names for hub detection (union of operation entities). */
  entityTypes: string[];
  frontendRoot: string;
  projectRoot: string;
  existing: Sitemap;
}

export function buildSitemap(input: BuildSitemapInput): Sitemap {
  const routes = detectRoutes(input.frontendRoot);
  const routeByComponent = new Map(routes.map((r) => [r.component, r]));
  const hubTypes = input.entityTypes;

  // Page set = components that issue backend calls ∪ components named in routes.
  const components = new Map<string, { name: string }>();
  for (const p of input.pages) components.set(p.name, { name: p.name });
  for (const r of routes) if (!components.has(r.component)) components.set(r.component, { name: r.component });

  const detected: PageNode[] = [...components.values()].map(({ name }) => {
    const route = routeByComponent.get(name);
    const parent = route?.parentComponent ? toPageId(route.parentComponent) : null;
    const node: PageNode = { id: toPageId(name), name };
    if (route?.path) node.route = route.path;
    if (parent) node.parent = parent;
    const hub = detectEntityHub(name, route?.path, hubTypes);
    if (hub) node.entityHub = hub;
    return node;
  });

  return mergeSitemap(input.existing, { pages: detected, transitions: [] });
}

/** Match a page to a schema core type to flag it as that entity's detail hub. */
function detectEntityHub(name: string, route: string | undefined, types: string[]): string | undefined {
  // A detail hub is signalled by an :id route param or a detail/profile name —
  // NOT "page"/"view" (almost every component ends in those).
  const looksLikeDetail = /:[A-Za-z]*[Ii]d\b/.test(route ?? "") || /(detail|profile)/i.test(name);
  if (!looksLikeDetail) return undefined;
  const hay = `${name} ${route ?? ""}`.toLowerCase();
  // Longest type name first, so "MembershipCard" wins over "Card".
  for (const t of [...types].sort((a, b) => b.length - a.length)) {
    if (hay.includes(t.toLowerCase())) return t;
  }
  return undefined;
}

/**
 * Non-destructive merge: keep every existing page (humans own the sitemap once
 * authored), only filling blank machine fields and adding newly-found pages.
 * Existing transitions are preserved; the machine adds none.
 */
export function mergeSitemap(existing: Sitemap, detected: Sitemap): Sitemap {
  const byId = new Map<string, PageNode>();
  for (const p of detected.pages) byId.set(p.id, { ...p });
  for (const e of existing.pages) {
    const d = byId.get(e.id);
    if (!d) {
      byId.set(e.id, { ...e }); // human-added page the machine didn't rediscover — keep
      continue;
    }
    // Existing wins on human-editable fields; fill blanks from detection.
    byId.set(e.id, {
      id: e.id,
      name: e.name || d.name,
      route: e.route ?? d.route,
      parent: e.parent !== undefined ? e.parent : d.parent,
      entityHub: e.entityHub ?? d.entityHub,
    });
  }
  const pages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { pages, transitions: existing.transitions ?? [] };
}

// ── Route detection (best-effort, React Router) ─────────────────────────────

function detectRoutes(frontendRoot: string): RouteHit[] {
  const project = createFrontendProject(frontendRoot);
  const hits: RouteHit[] = [];
  for (const sf of project.getSourceFiles()) {
    // JSX <Route path=... element={<Comp/>} /> (and component={Comp})
    for (const kind of [SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxOpeningElement] as const) {
      for (const el of sf.getDescendantsOfKind(kind)) {
        if (tagName(el) !== "Route") continue;
        const component = jsxComponentAttr(el);
        if (!component) continue;
        hits.push({ component, path: jsxStringAttr(el, "path"), parentComponent: enclosingRouteComponent(el) });
      }
    }
    // Route-config objects: { path: "...", element: <Comp/> | component: Comp }
    for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const path = objStringProp(obj, "path");
      const component = objComponentProp(obj);
      if (!path && !component) continue;
      if (!component) continue;
      hits.push({ component, path, parentComponent: enclosingRouteObjectComponent(obj) });
    }
  }
  return dedupeRoutes(hits);
}

function dedupeRoutes(hits: RouteHit[]): RouteHit[] {
  const byComponent = new Map<string, RouteHit>();
  for (const h of hits) {
    const prev = byComponent.get(h.component);
    // Prefer the richest hit (one that has a path / parent).
    if (!prev || (!prev.path && h.path) || (!prev.parentComponent && h.parentComponent)) {
      byComponent.set(h.component, { ...prev, ...h, component: h.component });
    }
  }
  return [...byComponent.values()];
}

function tagName(el: Node): string {
  if (Node.isJsxSelfClosingElement(el) || Node.isJsxOpeningElement(el)) {
    return el.getTagNameNode().getText();
  }
  return "";
}

function jsxStringAttr(el: Node, name: string): string | undefined {
  if (!Node.isJsxSelfClosingElement(el) && !Node.isJsxOpeningElement(el)) return undefined;
  const attr = el.getAttribute(name);
  if (!attr || !Node.isJsxAttribute(attr)) return undefined;
  const init = attr.getInitializer();
  if (init && Node.isStringLiteral(init)) return init.getLiteralText();
  if (init && Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (expr && Node.isStringLiteral(expr)) return expr.getLiteralText();
  }
  return undefined;
}

/** Component referenced by `element={<Comp/>}` or `component={Comp}`. */
function jsxComponentAttr(el: Node): string | undefined {
  if (!Node.isJsxSelfClosingElement(el) && !Node.isJsxOpeningElement(el)) return undefined;
  const element = el.getAttribute("element");
  if (element && Node.isJsxAttribute(element)) {
    const init = element.getInitializer();
    if (init && Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr && Node.isJsxSelfClosingElement(expr)) {
        const tag = expr.getTagNameNode().getText();
        if (isComponentTag(tag)) return tag;
      }
      if (expr && Node.isJsxElement(expr)) {
        const tag = expr.getOpeningElement().getTagNameNode().getText();
        if (isComponentTag(tag)) return tag;
      }
      if (expr && Node.isIdentifier(expr) && isComponentTag(expr.getText())) return expr.getText();
    }
  }
  const component = el.getAttribute("component");
  if (component && Node.isJsxAttribute(component)) {
    const init = component.getInitializer();
    if (init && Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr && Node.isIdentifier(expr) && isComponentTag(expr.getText())) return expr.getText();
    }
  }
  return undefined;
}

function objStringProp(obj: Node, name: string): string | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = obj.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    if (init && Node.isStringLiteral(init)) return init.getLiteralText();
  }
  return undefined;
}

function objComponentProp(obj: Node): string | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  for (const name of ["element", "component", "Component"]) {
    const prop = obj.getProperty(name);
    if (prop && Node.isPropertyAssignment(prop)) {
      const init = prop.getInitializer();
      if (init && (Node.isJsxSelfClosingElement(init) || Node.isJsxElement(init))) {
        const tag = Node.isJsxElement(init)
          ? init.getOpeningElement().getTagNameNode().getText()
          : init.getTagNameNode().getText();
        if (isComponentTag(tag)) return tag;
      }
      if (init && Node.isIdentifier(init) && isComponentTag(init.getText())) return init.getText();
    }
  }
  return undefined;
}

function enclosingRouteComponent(el: Node): string | undefined {
  // Start ABOVE this route's own JsxElement so a <Route> doesn't match itself.
  const routeNode = Node.isJsxOpeningElement(el) ? el.getParent() : el;
  let cur: Node | undefined = routeNode?.getParent();
  while (cur) {
    if (Node.isJsxElement(cur) && tagName(cur.getOpeningElement()) === "Route") {
      const comp = jsxComponentAttr(cur.getOpeningElement());
      if (comp) return comp;
    }
    cur = cur.getParent();
  }
  return undefined;
}

function enclosingRouteObjectComponent(obj: Node): string | undefined {
  let cur: Node | undefined = obj.getParent();
  while (cur) {
    if (Node.isObjectLiteralExpression(cur) && cur !== obj) {
      const comp = objComponentProp(cur);
      if (comp && objStringProp(cur, "path") !== undefined) return comp;
    }
    cur = cur.getParent();
  }
  return undefined;
}

function isComponentTag(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Compute the page path from root → page by walking `parent` links. */
export function pagePath(sitemap: Sitemap, pageId: string): PageNode[] {
  const byId = new Map(sitemap.pages.map((p) => [p.id, p]));
  const chain: PageNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(pageId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return chain;
}
