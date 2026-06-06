import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcile } from "../src/core/reconcile.js";
import type { Capability } from "../src/core/model.js";
import {
  loadAllCapabilities,
  persistReconciled,
  writeCapabilityFile,
  moduleFilePath,
} from "../src/core/yaml-store.js";
import { scaffoldFeatureMap, defaultProjectConfig } from "../src/config/project.js";

const cap = (over: Partial<Capability> & { id: string }): Capability => ({
  name: over.id,
  statement: "machine statement",
  object: [],
  mounted_on: [],
  status: "pending",
  source: "introspection",
  ...over,
});

test("new id is added as the machine drafted it", () => {
  const res = reconcile([], [cap({ id: "cap.a", status: "pending" })]);
  assert.deepEqual(res.added, ["cap.a"]);
  assert.equal(res.caps.length, 1);
});

test("human fields (name/statement/status) are preserved; machine fields refreshed", () => {
  const existing = [
    cap({
      id: "cap.a",
      name: "人工命名",
      statement: "operator reworded this",
      status: "approved",
      object: ["OldType"],
      operations: ["a"],
      mounted_on: ["page.x"],
    }),
  ];
  const drafts = [
    cap({
      id: "cap.a",
      name: "MACHINE NAME",
      statement: "machine statement",
      status: "pending",
      object: ["NewType"],
      operations: ["a", "b"],
      mounted_on: ["page.x"],
    }),
  ];
  const merged = reconcile(existing, drafts).caps[0];
  assert.equal(merged.name, "人工命名", "human name preserved");
  assert.equal(merged.statement, "operator reworded this", "human statement preserved");
  assert.equal(merged.status, "approved", "human status preserved");
  assert.deepEqual(merged.object, ["NewType"], "object refreshed from code");
  assert.deepEqual(merged.operations, ["a", "b"], "resolvers refreshed from code");
});

test("mounted_on union preserves a manually-added mount", () => {
  const existing = [cap({ id: "cap.a", mounted_on: ["page.manual", "page.auto"] })];
  const drafts = [cap({ id: "cap.a", mounted_on: ["page.auto"] })]; // code only knows page.auto
  const merged = reconcile(existing, drafts).caps[0];
  assert.deepEqual(merged.mounted_on, ["page.auto", "page.manual"], "manual mount survives");
});

test("a capability gone from code is deprecated, never deleted", () => {
  const existing = [cap({ id: "cap.gone", status: "approved" }), cap({ id: "cap.keep" })];
  const drafts = [cap({ id: "cap.keep" })];
  const res = reconcile(existing, drafts);
  assert.deepEqual(res.deprecated, ["cap.gone"]);
  const gone = res.caps.find((c) => c.id === "cap.gone");
  assert.ok(gone, "deprecated cap is kept, not removed");
  assert.equal(gone!.status, "deprecated");
});

test("unknown auto-advances to pending once a call-site appears", () => {
  const existing = [cap({ id: "cap.a", status: "unknown", mounted_on: [] })];
  const drafts = [cap({ id: "cap.a", status: "pending", mounted_on: ["page.x"] })];
  const merged = reconcile(existing, drafts).caps[0];
  assert.equal(merged.status, "pending");
  assert.deepEqual(merged.mounted_on, ["page.x"]);
});

test("a human-chosen status is never machine-downgraded", () => {
  // approved cap whose call-site vanished — stays approved (mounts just empty out)
  const existing = [cap({ id: "cap.a", status: "approved", mounted_on: ["page.x"] })];
  const drafts = [cap({ id: "cap.a", status: "unknown", mounted_on: [] })];
  const merged = reconcile(existing, drafts).caps[0];
  assert.equal(merged.status, "approved");
});

test("source provenance is preserved", () => {
  const existing = [cap({ id: "cap.a", source: "ops" })];
  const drafts = [cap({ id: "cap.a", source: "introspection" })];
  assert.equal(reconcile(existing, drafts).caps[0].source, "ops");
});

test("code_anchor preserved when machine has none, refreshed when it does", () => {
  const existing = [cap({ id: "cap.a", code_anchor: "src/old.ts#fn" })];
  const noAnchorDraft = [cap({ id: "cap.a" })];
  assert.equal(reconcile(existing, noAnchorDraft).caps[0].code_anchor, "src/old.ts#fn");
  const newAnchorDraft = [cap({ id: "cap.a", code_anchor: "src/new.ts#fn" })];
  assert.equal(reconcile(existing, newAnchorDraft).caps[0].code_anchor, "src/new.ts#fn");
});

test("id drift: a renamed draft re-associates with the existing cap by unique operation set", () => {
  const existing = [cap({ id: "cap.old", name: "人工命名", status: "approved", operations: ["POST /api/jobs"] })];
  const drafts = [cap({ id: "cap.machine_renamed", name: "machine", operations: ["POST /api/jobs"] })];
  const res = reconcile(existing, drafts);
  assert.deepEqual(res.deprecated, [], "no deprecation — re-associated by operations");
  assert.deepEqual(res.added, [], "not added as a new cap");
  const merged = res.caps.find((c) => (c.operations ?? [])[0] === "POST /api/jobs")!;
  assert.equal(merged.id, "cap.old", "keeps the existing id");
  assert.equal(merged.name, "人工命名", "keeps the human name");
});

test("ops-fallback does NOT mis-associate split caps that share one operation", () => {
  const existing = [
    cap({ id: "cap.renew", name: "续费", operations: ["updateCard"] }),
    cap({ id: "cap.upgrade", name: "升级", operations: ["updateCard"] }),
  ];
  // a single drifted draft with the same shared op must NOT silently claim either
  const drafts = [cap({ id: "cap.changed", operations: ["updateCard"] })];
  const res = reconcile(existing, drafts);
  assert.equal(res.added.length, 1, "ambiguous ops → treated as new, not a wrong re-association");
});

test("reconcile is idempotent: feeding the result back changes nothing", () => {
  const existing = [cap({ id: "cap.a", name: "人工", status: "approved", operations: ["a"] })];
  const drafts = [cap({ id: "cap.a", name: "machine", operations: ["a"] })];
  const once = reconcile(existing, drafts);
  const twice = reconcile(once.caps, drafts);
  assert.deepEqual(twice.updated, []);
  assert.deepEqual(twice.unchanged, ["cap.a"]);
  assert.deepEqual(twice.caps, once.caps);
});

test("VERIFY scenario end-to-end: approve + reword survives a rebuild through YAML", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmap-rec-"));
  try {
    scaffoldFeatureMap(defaultProjectConfig(), tmp);

    // Build 1: machine writes a pending capability.
    const draft1 = cap({
      id: "cap.purchase_trial_card",
      name: "购买体验卡",
      statement: "machine draft statement",
      object: ["MembershipCard"],
      operations: ["purchaseTrialCard"],
      mounted_on: ["page.cardpage"],
    });
    writeCapabilityFile(moduleFilePath("membership-card", tmp), [draft1]);

    // Human edits the YAML: approve + reword + add a manual mount.
    const file = moduleFilePath("membership-card", tmp);
    let yaml = fs.readFileSync(file, "utf8");
    yaml = yaml
      .replace("name: 购买体验卡", "name: 购买体验卡（已核）")
      .replace("statement: machine draft statement", "statement: 在收银台和会员卡详情页都能购买体验卡")
      .replace("status: pending", "status: approved")
      .replace("- page.cardpage", "- page.cardpage\n    - page.member_card_detail");
    fs.writeFileSync(file, yaml);

    // Build 2: re-extract (machine name/statement differ; resolvers changed).
    const loaded = loadAllCapabilities(tmp);
    const draft2 = cap({
      id: "cap.purchase_trial_card",
      name: "MACHINE WOULD RENAME",
      statement: "machine would reword",
      object: ["MembershipCard", "User"],
      operations: ["purchaseTrialCard"],
      mounted_on: ["page.cardpage"],
    });
    const result = reconcile(loaded.caps, [draft2]);
    persistReconciled(result.caps, loaded.fileOf, new Map(), loaded.byFile.keys(), tmp);

    const after = loadAllCapabilities(tmp).caps.find((c) => c.id === "cap.purchase_trial_card")!;
    assert.equal(after.name, "购买体验卡（已核）", "human name survived");
    assert.equal(after.statement, "在收银台和会员卡详情页都能购买体验卡", "human statement survived");
    assert.equal(after.status, "approved", "human approval survived");
    assert.ok(after.mounted_on.includes("page.member_card_detail"), "manual mount survived");
    assert.deepEqual(after.object, ["MembershipCard", "User"], "machine object refreshed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
