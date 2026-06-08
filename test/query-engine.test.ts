import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCapability,
  searchCapabilities,
  resolveReach,
  resolveCapability,
  findCapabilities,
} from "../src/core/query-engine.js";
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

test("scoring weights: name beats statement-only; deprecated/unknown demoted", () => {
  assert.equal(scoreCapability(cap({ id: "x", name: "revenue report" }), "revenue"), 100);
  assert.equal(scoreCapability(cap({ id: "x", name: "n", statement: "shows revenue" }), "revenue"), 20);
  assert.equal(scoreCapability(cap({ id: "x", name: "revenue", status: "deprecated" }), "revenue"), 50);
  assert.equal(scoreCapability(cap({ id: "x", name: "nope" }), "revenue"), 0);
});

test("word-aware: a short ASCII query does not match mid-word ('ai' ⊄ 'email')", () => {
  const c = cap({
    id: "cap.verify_email",
    name: "Verify email",
    statement: "verify their email on the auth page",
    object: ["Verify-email"],
    operations: ["GET /verify-email"],
  });
  assert.equal(scoreCapability(c, "ai"), 0, "'ai' must not match inside 'email'/'auth'");
  assert.ok(scoreCapability(c, "email") > 0, "whole word 'email' matches");
  assert.ok(scoreCapability(c, "veri") > 0, "word-prefix 'veri' matches 'verify'");
});

test("camelCase is split so 'email' matches 'verifyEmail'", () => {
  assert.ok(scoreCapability(cap({ id: "x", name: "verifyEmail" }), "email") > 0);
});

test("CJK query falls back to substring matching", () => {
  assert.ok(scoreCapability(cap({ id: "x", name: "查看店铺营业额" }), "营业额") > 0);
});

test("searchCapabilities sorts by score and drops zero-score", () => {
  const caps = [
    cap({ id: "cap.b", name: "b", statement: "mentions revenue" }), // 20
    cap({ id: "cap.a", name: "revenue dashboard" }), // 100
    cap({ id: "cap.c", name: "unrelated" }), // 0 → dropped
  ];
  const ranked = searchCapabilities(caps, "revenue");
  assert.deepEqual(ranked.map((r) => r.capability.id), ["cap.a", "cap.b"]);
  assert.equal(ranked[0].score, 100);
});

test("resolveReach: known page → display + not missing; unknown page → missing", () => {
  const reach = resolveReach(sitemap, cap({ id: "x", mounted_on: ["page.finance", "page.ghost"] }));
  assert.equal(reach[0].display, "Dashboard  ›  FinancePage");
  assert.equal(reach[0].missing, false);
  assert.equal(reach[1].display, "");
  assert.equal(reach[1].missing, true);
});

test("resolveCapability: anchor null vs set; empty mounts → empty reach", () => {
  const noAnchor = resolveCapability(sitemap, cap({ id: "x" }));
  assert.equal(noAnchor.anchor, null);
  assert.deepEqual(noAnchor.reach, []);
  const withAnchor = resolveCapability(sitemap, cap({ id: "x", code_anchor: "src/a.ts#fn" }));
  assert.equal(withAnchor.anchor, "src/a.ts#fn");
});

test("findCapabilities: end-to-end ranked + resolved with score", () => {
  const caps = [
    cap({ id: "cap.rev", name: "revenue", mounted_on: ["page.finance"], code_anchor: "a#b" }),
    cap({ id: "cap.other", name: "other" }),
  ];
  const results = findCapabilities(caps, sitemap, "revenue");
  assert.equal(results.length, 1);
  assert.equal(results[0].capability.id, "cap.rev");
  assert.equal(results[0].score, 100);
  assert.equal(results[0].reach[0].display, "Dashboard  ›  FinancePage");
  assert.equal(results[0].anchor, "a#b");
});
