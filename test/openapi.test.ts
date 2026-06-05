import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openapiSource } from "../src/core/sources/openapi.js";
import { classify } from "../src/core/classify.js";
import type { SourceConfig } from "../src/core/sources/source.js";
import type { Operation } from "../src/core/operation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, "fixtures/openapi/openapi.yaml");
const frontendDir = path.join(here, "fixtures/openapi/frontend");
const cfg: SourceConfig = { type: "openapi", specPath };

const op = (ops: Operation[], name: string): Operation => ops.find((o) => o.name === name)!;

test("spec → operations (path × method), entities from $ref, health is noise", async () => {
  const ops = await openapiSource.loadOperations(cfg, here);
  const names = ops.map((o) => o.name).sort();
  assert.deepEqual(names, [
    "DELETE /users/{id}",
    "GET /health",
    "GET /stores/{storeId}/revenue",
    "GET /stores/{storeId}/revenue/today",
    "GET /users/{id}",
    "POST /cards/trial",
    "POST /users",
  ]);
  assert.deepEqual(op(ops, "GET /stores/{storeId}/revenue/today").entities, ["Revenue"]);
  assert.equal(op(ops, "POST /cards/trial").entities.includes("MembershipCard"), true);
  assert.equal(op(ops, "GET /health").noise, true);
});

test("fetch/axios call-sites match path templates (base path tolerated); dynamic URL → UNRESOLVED", async () => {
  const ops = await openapiSource.loadOperations(cfg, here);
  const usage = openapiSource.scanUsage(ops, frontendDir, here);
  const matched = usage.sites.map((s) => s.operation).sort();
  assert.deepEqual(matched, [
    "DELETE /users/{id}",
    "GET /stores/{storeId}/revenue/today",
    "POST /cards/trial",
    "POST /users",
  ]);
  // the revenue call is mounted on the finance page
  const rev = usage.sites.find((s) => s.operation === "GET /stores/{storeId}/revenue/today");
  assert.equal(rev!.pageName, "FinancePage");
  // the dynamic fetch(url) is held, not force-matched
  assert.equal(usage.unresolved.length, 1);
});

test("classification: matched ops are user_capability, health is noise", async () => {
  const ops = await openapiSource.loadOperations(cfg, here);
  const usage = openapiSource.scanUsage(ops, frontendDir, here);
  const classified = classify(ops, usage);
  const q = (name: string) => classified.find((c) => c.operation.name === name)!.quadrant;
  assert.equal(q("GET /stores/{storeId}/revenue/today"), "user_capability");
  assert.equal(q("POST /users"), "user_capability");
  assert.equal(q("GET /health"), "noise");
  // uncalled + dynamic sites present → unknown, not no_entry
  assert.equal(q("GET /stores/{storeId}/revenue"), "unknown");
});
