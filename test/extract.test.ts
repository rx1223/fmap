import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, introspectResolvers } from "../src/core/introspect.js";
import { getScanner } from "../src/core/scan-frontend.js";
import { extractCapabilities, groupByModule } from "../src/core/extract.js";
import { writeCapabilitiesByModule, loadAllCapabilities } from "../src/core/yaml-store.js";
import { defaultProjectConfig } from "../src/config/project.js";
import { scaffoldFeatureMap } from "../src/config/project.js";
import { StubProvider } from "./helpers/stub-provider.js";
import type { Capability } from "../src/core/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "fixtures/schema.graphql");
const frontendDir = path.join(here, "fixtures/frontend");

// Canned LLM output: demonstrates MERGE (3 revenue resolvers → 1), SPLIT
// (updateMembershipCard → 3 card actions), and DROP (legacyRevenue, login omitted).
const CANNED = JSON.stringify([
  { id: "view_store_revenue", name: "查看店铺营业额", statement: "在财务页能看到店铺的实时与历史营业额", module: "store-finance", resolvers: ["todayRevenue", "revenueByRange", "revenueBreakdown"] },
  { id: "export_revenue_report", name: "导出营业报表", statement: "导出指定店铺的营业报表", module: "store-finance", resolvers: ["exportReport"] },
  { id: "view_store_detail", name: "查看店铺详情", statement: "查看指定店铺的详情", module: "store-finance", resolvers: ["store"] },
  { id: "create_user", name: "创建用户", statement: "在用户管理页创建新用户", module: "user", resolvers: ["createUser"] },
  { id: "delete_user", name: "删除用户", statement: "在用户管理页删除用户", module: "user", resolvers: ["deleteUser"] },
  { id: "view_current_user", name: "查看当前登录用户", statement: "在用户管理页查看当前登录用户", module: "user", resolvers: ["currentUser"] },
  { id: "view_user_detail", name: "查看用户详情", statement: "查看指定用户的详情", module: "user", resolvers: ["user"] },
  { id: "renew_card", name: "续费会员卡", statement: "在收银台为用户续费会员卡", module: "membership-card", resolvers: ["updateMembershipCard"] },
  { id: "upgrade_card", name: "升级会员卡", statement: "在收银台为用户升级会员卡", module: "membership-card", resolvers: ["updateMembershipCard"] },
  { id: "replace_card", name: "更换会员卡", statement: "在收银台为用户更换会员卡", module: "membership-card", resolvers: ["updateMembershipCard"] },
  { id: "purchase_trial_card", name: "购买体验卡", statement: "在收银台给用户购买体验卡", module: "membership-card", resolvers: ["purchaseTrialCard"] },
]);

async function extractFixture() {
  const cfg = defaultProjectConfig({ schema: { sdlPath: schemaPath }, frontend: { root: frontendDir } });
  const schema = await loadSchema(cfg, here);
  const resolvers = introspectResolvers(schema);
  const scan = getScanner().scan(frontendDir, here);
  const drafts = await extractCapabilities({ resolvers, scan, config: cfg, provider: new StubProvider(CANNED) });
  return { drafts, cfg };
}

const byId = (caps: Capability[], id: string) => caps.find((c) => c.id === id);

test("MERGE: three revenue resolvers collapse into one capability", async () => {
  const { drafts } = await extractFixture();
  const rev = byId(drafts, "cap.view_store_revenue");
  assert.ok(rev, "cap.view_store_revenue exists");
  assert.deepEqual(rev!.resolvers, ["revenueBreakdown", "revenueByRange", "todayRevenue"]);
  assert.ok(rev!.object.includes("Revenue") && rev!.object.includes("RevenueBreakdown"));
  // todayRevenue is called on the finance page → mounted + pending.
  assert.deepEqual(rev!.mounted_on, ["page.financepage"]);
  assert.equal(rev!.status, "pending");
});

test("SPLIT: one mutation yields three capabilities sharing the resolver", async () => {
  const { drafts } = await extractFixture();
  const split = drafts.filter((d) => (d.resolvers ?? []).length === 1 && d.resolvers?.[0] === "updateMembershipCard");
  assert.equal(split.length, 3);
  for (const c of split) {
    assert.equal(c.status, "pending");
    assert.deepEqual(c.mounted_on, ["page.cardpage"]);
  }
  assert.equal(new Set(split.map((c) => c.id)).size, 3, "split ids are unique");
});

test("UNKNOWN quadrant → status unknown, empty mounts", async () => {
  const { drafts } = await extractFixture();
  const exp = byId(drafts, "cap.export_revenue_report");
  assert.equal(exp!.status, "unknown");
  assert.deepEqual(exp!.mounted_on, []);
});

test("NOISE is absent and dropped resolvers never appear", async () => {
  const { drafts } = await extractFixture();
  const allResolvers = new Set(drafts.flatMap((d) => d.resolvers));
  for (const n of ["node", "health", "__typename", "legacyRevenue", "login"]) {
    assert.equal(allResolvers.has(n), false, `${n} must not appear`);
  }
});

test("everything is pending/unknown (never approved) with source introspection", async () => {
  const { drafts } = await extractFixture();
  for (const d of drafts) {
    assert.ok(d.status === "pending" || d.status === "unknown", `${d.id} status`);
    assert.equal(d.source, "introspection");
  }
});

test("group by module → write → read round-trips into the expected files", async () => {
  const { drafts } = await extractFixture();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmap-"));
  try {
    scaffoldFeatureMap(defaultProjectConfig(), tmp);
    writeCapabilitiesByModule(groupByModule(drafts), tmp);
    const files = fs.readdirSync(path.join(tmp, "feature-map/capabilities")).filter((f: string) => f.endsWith(".yaml")).sort();
    assert.deepEqual(files, ["membership-card.yaml", "store-finance.yaml", "user.yaml"]);
    const { caps } = loadAllCapabilities(tmp);
    assert.equal(caps.length, drafts.length);
    // a known capability survives the round-trip intact
    const purchase = byId(caps, "cap.purchase_trial_card");
    assert.equal(purchase!.name, "购买体验卡");
    assert.equal(purchase!.status, "pending");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
