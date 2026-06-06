import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFindPayload,
  buildAnchorPayload,
  buildListPayload,
  buildReachPayload,
} from "../src/mcp/server.js";
import type { Capability, Sitemap } from "../src/core/model.js";

const cap = (over: Partial<Capability> & { id: string }): Capability => ({
  name: over.id,
  statement: "",
  object: [],
  mounted_on: [],
  status: "pending",
  source: "introspection",
  ...over,
});

const sitemap: Sitemap = {
  pages: [
    { id: "page.dashboard", name: "Dashboard" },
    { id: "page.finance", name: "FinancePage", parent: "page.dashboard" },
  ],
  transitions: [],
};

const caps: Capability[] = [
  cap({ id: "cap.rev", name: "view revenue", mounted_on: ["page.finance"], code_anchor: "src/a.ts#fn", operations: ["todayRevenue"] }),
  cap({ id: "cap.ops", name: "ops only", status: "pending" }),
  cap({ id: "cap.old", name: "legacy revenue", status: "deprecated" }),
];

const data = (r: { ok: true; data: unknown } | { ok: false; message: string }) => {
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.ok ? (r.data as Record<string, unknown>) : {};
};

test("find_capability: ranked matches as a DTO with anchor + reach", () => {
  const d = data(buildFindPayload(caps, sitemap, "revenue"));
  const matches = d.matches as Array<Record<string, unknown>>;
  assert.equal(matches[0].id, "cap.rev"); // live before deprecated
  assert.equal(matches[0].code_anchor, "src/a.ts#fn");
  assert.deepEqual((matches[0].reach as Array<{ display: string }>)[0].display, "Dashboard  ›  FinancePage");
});

test("get_anchor: returns the anchor; isError for an unknown id", () => {
  const ok = buildAnchorPayload(caps, "cap.rev");
  assert.ok(ok.ok && (ok.data as Record<string, unknown>).code_anchor === "src/a.ts#fn");
  const bad = buildAnchorPayload(caps, "cap.nope");
  assert.equal(bad.ok, false);
});

test("list_capabilities: excludes deprecated by default; filter by status", () => {
  const all = data(buildListPayload(caps));
  assert.equal(all.count, 2, "deprecated excluded");
  const dep = data(buildListPayload(caps, "deprecated"));
  assert.equal(dep.count, 1);
});

test("how_to_reach: reach path for a mounted cap; note for a backend cap", () => {
  const reach = data(buildReachPayload(caps, sitemap, "cap.rev"));
  assert.equal((reach.reach as Array<{ display: string }>)[0].display, "Dashboard  ›  FinancePage");
  const ops = data(buildReachPayload(caps, sitemap, "cap.ops"));
  assert.deepEqual(ops.reach, []);
  assert.match(ops.note as string, /backend\/ops/);
});
