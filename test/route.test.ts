import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeSource } from "../src/core/sources/route.js";
import { classify } from "../src/core/classify.js";
import { extractCapabilities } from "../src/core/extract.js";
import { defaultProjectConfig } from "../src/config/project.js";
import { StubProvider } from "./helpers/stub-provider.js";
import type { SourceConfig } from "../src/core/sources/source.js";
import type { Operation } from "../src/core/operation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Reuse the OpenAPI fixture frontend for usage (same fetch/axios call-sites).
const frontendDir = path.join(here, "fixtures/openapi/frontend");
const cfg: SourceConfig = { type: "route", root: "fixtures/route" };

const op = (ops: Operation[], name: string): Operation => ops.find((o) => o.name === name)!;

test("route definitions → operations: Express + Next app-router + pages API", async () => {
  const ops = await routeSource.loadOperations(cfg, here);
  const names = ops.map((o) => o.name);
  // Express (':id' normalised to '{id}')
  assert.ok(names.includes("GET /stores/{storeId}/revenue/today"));
  assert.ok(names.includes("DELETE /users/{id}"));
  // Next app-router file → exported methods
  assert.ok(names.includes("GET /api/orders"));
  assert.ok(names.includes("POST /api/orders"));
  // Next pages API → method unknown (ALL)
  assert.ok(names.includes("ALL /api/ping"));
  // noise
  assert.equal(op(ops, "GET /health").noise, true);
  assert.equal(op(ops, "ALL /api/ping").noise, true);
});

test("operations carry a code anchor pointing at the handler file", async () => {
  const ops = await routeSource.loadOperations(cfg, here);
  assert.ok(op(ops, "POST /users").anchor?.endsWith("server/routes.ts"));
  assert.ok(op(ops, "GET /api/orders").anchor?.includes("app/api/orders/route.ts#GET"));
});

test("frontend fetch/axios call-sites match route operations; dynamic URL → UNRESOLVED", async () => {
  const ops = await routeSource.loadOperations(cfg, here);
  const usage = routeSource.scanUsage(ops, frontendDir, here);
  const matched = usage.sites.map((s) => s.operation).sort();
  assert.deepEqual(matched, [
    "DELETE /users/{id}",
    "GET /stores/{storeId}/revenue/today",
    "POST /cards/trial",
    "POST /users",
  ]);
  assert.equal(usage.unresolved.length, 1);

  const classified = classify(ops, usage);
  const q = (name: string) => classified.find((c) => c.operation.name === name)!.quadrant;
  assert.equal(q("POST /users"), "user_capability");
  assert.equal(q("GET /api/orders"), "unknown"); // uncalled + dynamic sites present
});

test("extracted capability carries the source-supplied code anchor", async () => {
  const ops = await routeSource.loadOperations(cfg, here);
  const usage = routeSource.scanUsage(ops, frontendDir, here);
  const classified = classify(ops, usage);
  const canned = JSON.stringify([
    { id: "create_user", name: "Create user", statement: "Create a user", module: "user", operations: ["POST /users"] },
  ]);
  const drafts = await extractCapabilities({
    classified,
    sites: usage.sites,
    config: defaultProjectConfig(),
    provider: new StubProvider(canned),
  });
  const cap = drafts.find((d) => d.id === "cap.create_user");
  assert.ok(cap?.code_anchor?.endsWith("server/routes.ts"), `anchor should point at the handler: ${cap?.code_anchor}`);
});
