import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isUniversalNoise } from "../src/core/classify.js";
import type { Operation } from "../src/core/operation.js";
import type { UsageResult } from "../src/core/frontend-ast.js";

const op = (name: string, extra: Partial<Operation> = {}): Operation => ({
  sourceId: "graphql",
  name,
  kind: "query",
  entities: [],
  ...extra,
});

const emptyUsage: UsageResult = { sites: [], unresolved: [], pages: [] };

test("cross-protocol noise is recognised; real ops are not", () => {
  for (const n of ["health", "ping", "__typename", "readiness"]) {
    assert.equal(isUniversalNoise(n), true, n);
  }
  assert.equal(isUniversalNoise("todayRevenue"), false);
  assert.equal(isUniversalNoise("node"), false, "Relay node is source-specific noise, not universal");
});

test("called operation → user_capability with its pages", () => {
  const usage: UsageResult = {
    sites: [{ operation: "todayRevenue", kind: "query", pageId: "page.finance", pageName: "Finance", file: "Finance.tsx" }],
    unresolved: [],
    pages: [],
  };
  const [c] = classify([op("todayRevenue")], usage);
  assert.equal(c.quadrant, "user_capability");
  assert.deepEqual(c.pages, [{ id: "page.finance", name: "Finance" }]);
});

test("uncalled operation → no_entry when the scanner is confident (no unresolved sites)", () => {
  const [c] = classify([op("exportReport")], emptyUsage);
  assert.equal(c.quadrant, "no_entry");
});

test("uncalled operation → unknown when the scan has blind spots", () => {
  const usage: UsageResult = {
    sites: [],
    unresolved: [{ file: "Messy.tsx", reason: "dynamic", snippet: "useQuery(q[x])" }],
    pages: [],
  };
  const [c] = classify([op("exportReport")], usage);
  assert.equal(c.quadrant, "unknown");
});

test("a source-flagged noise operation is classified noise regardless of calls", () => {
  const [c] = classify([op("node", { noise: true })], emptyUsage);
  assert.equal(c.quadrant, "noise");
});
