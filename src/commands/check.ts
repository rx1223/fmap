import fs from "node:fs";
import path from "node:path";
import { isInitialized, readProjectConfig } from "../config/project.js";
import { dirExists } from "../core/fs-utils.js";
import { getSource } from "../core/sources/index.js";
import { classify, type ClassifiedOperation } from "../core/classify.js";
import type { UsageResult } from "../core/frontend-ast.js";
import { loadAllCapabilities } from "../core/yaml-store.js";

const EMPTY_USAGE: UsageResult = { sites: [], unresolved: [], pages: [] };

/**
 * `fmap check` — drift detection between the map and code (read-only, no LLM).
 * Source-agnostic: gathers operations from every configured source, then reports
 * stale operations (renamed/removed), vanished approved capabilities, dead code
 * anchors, and new uncovered operations. Exits non-zero on drift so a CI step
 * *can* use it later (no CI wired in this phase).
 */
export async function checkCommand(): Promise<void> {
  const cwd = process.cwd();
  if (!isInitialized(cwd)) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }

  const cfg = readProjectConfig(cwd);
  const frontendRoot = path.resolve(cwd, cfg.frontend.root);
  const haveFrontend = dirExists(frontendRoot);

  const operationNames = new Set<string>();
  const classified: ClassifiedOperation[] = [];
  for (const sc of cfg.sources) {
    const source = getSource(sc.type);
    if (!source) continue;
    try {
      const operations = await source.loadOperations(sc, cwd);
      for (const op of operations) operationNames.add(op.name);
      const usage = haveFrontend ? source.scanUsage(operations, frontendRoot, cwd) : EMPTY_USAGE;
      classified.push(...classify(operations, usage));
    } catch (e) {
      console.warn(`Warning: source "${sc.type}" failed — ${(e as Error).message}`);
    }
  }
  const nonNoise = classified.filter((c) => c.quadrant !== "noise").map((c) => c.operation.name);

  const { caps } = loadAllCapabilities(cwd);
  const live = caps.filter((c) => c.status !== "deprecated");
  const covered = new Set(live.flatMap((c) => c.resolvers ?? []));

  const staleOperations: { id: string; missing: string[] }[] = [];
  const vanishedApproved: string[] = [];
  const deadAnchors: { id: string; file: string }[] = [];

  for (const c of live) {
    const refs = c.resolvers ?? [];
    const missing = refs.filter((r) => !operationNames.has(r));
    if (missing.length) staleOperations.push({ id: c.id, missing });
    if (c.status === "approved" && refs.length > 0 && refs.every((r) => !operationNames.has(r))) {
      vanishedApproved.push(c.id);
    }
    if (c.code_anchor) {
      const file = c.code_anchor.split("#")[0];
      if (file && !fs.existsSync(path.resolve(cwd, file))) deadAnchors.push({ id: c.id, file });
    }
  }
  const newOperations = nonNoise.filter((n) => !covered.has(n));

  // ── report ────────────────────────────────────────────────────────────────
  let drift = 0;
  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    drift += lines.length;
    console.log(`\n${title}`);
    for (const l of lines) console.log(`  ${l}`);
  };

  section(
    "Stale operations (referenced by the map but gone from the backend — rename the anchor):",
    staleOperations.map((s) => `${s.id} → ${s.missing.join(", ")}`),
  );
  section(
    "Vanished approved capabilities (approved, but all operations are gone — propose removal):",
    vanishedApproved,
  );
  section("Dead code anchors (file no longer exists):", deadAnchors.map((d) => `${d.id} → ${d.file}`));
  section(
    "New operations not in the map (run `fmap build` to draft them):",
    newOperations,
  );

  if (drift === 0) {
    console.log("✓ No drift — the map matches the code.");
    process.exitCode = 0;
  } else {
    console.log(`\n✗ ${drift} drift item(s) found.`);
    process.exitCode = 1;
  }
}
