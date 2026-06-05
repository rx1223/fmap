import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { graphqlSource } from "../src/core/sources/graphql.js";
import { buildSitemap, pagePath } from "../src/core/sitemap.js";
import type { Sitemap } from "../src/core/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "fixtures/schema.graphql");
const frontendDir = path.join(here, "fixtures/frontend");

async function fixtureSitemap(existing: Sitemap = { pages: [], transitions: [] }): Promise<Sitemap> {
  const operations = await graphqlSource.loadOperations({ type: "graphql", sdlPath: schemaPath }, here);
  const usage = graphqlSource.scanUsage(operations, frontendDir, here);
  const entityTypes = [...new Set(operations.flatMap((o) => o.entities))];
  return buildSitemap({ pages: usage.pages, entityTypes, frontendRoot: frontendDir, projectRoot: here, existing });
}

const page = (sm: Sitemap, id: string) => sm.pages.find((p) => p.id === id);

test("React Router tree → pages with parent edges; root has no parent", async () => {
  const sm = await fixtureSitemap();
  assert.equal(page(sm, "page.dashboard")?.parent ?? null, null, "Dashboard is root");
  assert.equal(page(sm, "page.financepage")?.parent, "page.dashboard");
  assert.equal(page(sm, "page.cardpage")?.parent, "page.dashboard");
});

test("entity hub detected from :id route + detail name; plain pages are not hubs", async () => {
  const sm = await fixtureSitemap();
  assert.equal(page(sm, "page.userdetailpage")?.entityHub, "User");
  assert.equal(page(sm, "page.useradminpage")?.entityHub, undefined, "list page is not a hub");
});

test("pagePath walks parent links root → page", async () => {
  const sm = await fixtureSitemap();
  const names = pagePath(sm, "page.financepage").map((p) => p.name);
  assert.deepEqual(names, ["Dashboard", "FinancePage"]);
});

test("mergeSitemap preserves human edits (renamed page + a transition)", async () => {
  const human: Sitemap = {
    pages: [{ id: "page.financepage", name: "财务页", route: "/finance" }],
    transitions: [{ from: "page.financepage", to: "page.userdetailpage", note: "click a customer" }],
  };
  const sm = await fixtureSitemap(human);
  assert.equal(page(sm, "page.financepage")?.name, "财务页", "human name preserved");
  assert.equal(sm.transitions.length, 1, "human transition preserved");
});
