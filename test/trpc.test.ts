import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trpcSource } from "../src/core/sources/trpc.js";
import { classify } from "../src/core/classify.js";
import type { SourceConfig } from "../src/core/sources/source.js";
import type { Operation } from "../src/core/operation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, "fixtures/trpc/server");
const frontendDir = path.join(here, "fixtures/trpc/frontend");
const cfg: SourceConfig = { type: "trpc", root: serverDir };

const op = (ops: Operation[], name: string): Operation => ops.find((o) => o.name === name)!;

test("router tree → dotted procedure paths (sub-router consts resolved)", async () => {
  const ops = await trpcSource.loadOperations(cfg, here);
  assert.deepEqual(
    ops.map((o) => o.name).sort(),
    [
      "card.purchaseTrial",
      "store.detail",
      "store.revenue.range",
      "store.revenue.today",
      "user.create",
      "user.current",
      "user.remove",
    ],
  );
  assert.equal(op(ops, "store.revenue.today").kind, "query");
  assert.equal(op(ops, "user.create").kind, "mutation");
  assert.equal(op(ops, "card.purchaseTrial").kind, "mutation");
  // entity derived from the first path segment
  assert.deepEqual(op(ops, "store.revenue.today").entities, ["Store"]);
});

test("client chains (trpc.a.b.useQuery) match procedures; hook-result .mutate() is not a false match", async () => {
  const ops = await trpcSource.loadOperations(cfg, here);
  const usage = trpcSource.scanUsage(ops, frontendDir, here);
  assert.deepEqual(usage.sites.map((s) => s.operation).sort(), [
    "card.purchaseTrial",
    "store.revenue.today",
    "user.create",
    "user.current",
    "user.remove",
  ]);
  assert.equal(usage.sites.find((s) => s.operation === "store.revenue.today")!.pageName, "FinancePage");
  assert.equal(usage.unresolved.length, 0, "static tRPC chains → no blind spots");
});

test("tidy case: uncalled procedures are no_entry (scanner confident, no dynamic sites)", async () => {
  const ops = await trpcSource.loadOperations(cfg, here);
  const usage = trpcSource.scanUsage(ops, frontendDir, here);
  const classified = classify(ops, usage);
  const q = (name: string) => classified.find((c) => c.operation.name === name)!.quadrant;
  assert.equal(q("store.revenue.today"), "user_capability");
  assert.equal(q("user.create"), "user_capability");
  assert.equal(q("store.revenue.range"), "no_entry");
  assert.equal(q("store.detail"), "no_entry");
});
