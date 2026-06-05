import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isMechanicalNoise } from "../src/core/classify.js";
import type { ResolverInfo } from "../src/core/introspect.js";
import type { ScanResult } from "../src/core/scan-frontend.js";

const r = (name: string, extra: Partial<ResolverInfo> = {}): ResolverInfo => ({
  name,
  kind: "query",
  objectTypes: [],
  deprecated: false,
  ...extra,
});

const emptyScan: ScanResult = { sites: [], unresolved: [], pages: [] };

test("mechanical noise is recognised", () => {
  for (const n of ["__typename", "node", "_entities", "health", "__schema"]) {
    assert.equal(isMechanicalNoise(n), true, n);
  }
  assert.equal(isMechanicalNoise("todayRevenue"), false);
});

test("called resolver → user_capability with its pages", () => {
  const scan: ScanResult = {
    sites: [{ resolver: "todayRevenue", kind: "query", pageId: "page.finance", pageName: "Finance", file: "Finance.tsx" }],
    unresolved: [],
    pages: [],
  };
  const [c] = classify([r("todayRevenue")], scan);
  assert.equal(c.quadrant, "user_capability");
  assert.deepEqual(c.pages, [{ id: "page.finance", name: "Finance" }]);
});

test("uncalled resolver → no_entry when the scanner is confident (no unresolved sites)", () => {
  const [c] = classify([r("exportReport")], emptyScan);
  assert.equal(c.quadrant, "no_entry");
});

test("uncalled resolver → unknown when the scan has blind spots", () => {
  const scan: ScanResult = {
    sites: [],
    unresolved: [{ file: "Messy.tsx", reason: "dynamic", snippet: "useQuery(q[x])" }],
    pages: [],
  };
  const [c] = classify([r("exportReport")], scan);
  assert.equal(c.quadrant, "unknown");
});

test("noise resolver is classified noise regardless of calls", () => {
  const [c] = classify([r("node")], emptyScan);
  assert.equal(c.quadrant, "noise");
});
