import fs from "node:fs";
import path from "node:path";
import { isInitialized, readProjectConfig } from "../config/project.js";
import { dirExists } from "../core/fs-utils.js";
import { loadSchema, introspectResolvers } from "../core/introspect.js";
import { getScanner } from "../core/scan-frontend.js";
import { classify } from "../core/classify.js";
import { loadAllCapabilities } from "../core/yaml-store.js";

/**
 * `fmap check` — drift detection between the map and code (read-only, no LLM).
 * Reports stale resolvers (renamed/removed), vanished approved capabilities,
 * dead code anchors, and new uncovered resolvers. Exits non-zero on drift so a
 * CI step *can* use it later (no CI wired in this phase).
 */
export async function checkCommand(): Promise<void> {
  const cwd = process.cwd();
  if (!isInitialized(cwd)) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }

  const cfg = readProjectConfig(cwd);
  const schema = await loadSchema(cfg, cwd);
  const resolvers = introspectResolvers(schema);
  const resolverNames = new Set(resolvers.map((r) => r.name));

  const frontendRoot = path.resolve(cwd, cfg.frontend.root);
  const scan = dirExists(frontendRoot)
    ? getScanner().scan(frontendRoot, cwd)
    : { sites: [], unresolved: [], pages: [] };
  const classified = classify(resolvers, scan);
  const nonNoise = classified.filter((c) => c.quadrant !== "noise").map((c) => c.resolver.name);

  const { caps } = loadAllCapabilities(cwd);
  const live = caps.filter((c) => c.status !== "deprecated");
  const covered = new Set(live.flatMap((c) => c.resolvers ?? []));

  const staleResolvers: { id: string; missing: string[] }[] = [];
  const vanishedApproved: string[] = [];
  const deadAnchors: { id: string; file: string }[] = [];

  for (const c of live) {
    const refs = c.resolvers ?? [];
    const missing = refs.filter((r) => !resolverNames.has(r));
    if (missing.length) staleResolvers.push({ id: c.id, missing });
    if (c.status === "approved" && refs.length > 0 && refs.every((r) => !resolverNames.has(r))) {
      vanishedApproved.push(c.id);
    }
    if (c.code_anchor) {
      const file = c.code_anchor.split("#")[0];
      if (file && !fs.existsSync(path.resolve(cwd, file))) deadAnchors.push({ id: c.id, file });
    }
  }
  const newResolvers = nonNoise.filter((n) => !covered.has(n));

  // ── report ────────────────────────────────────────────────────────────────
  let drift = 0;
  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    drift += lines.length;
    console.log(`\n${title}`);
    for (const l of lines) console.log(`  ${l}`);
  };

  section(
    "Stale resolvers (referenced by the map but gone from the schema — rename the anchor):",
    staleResolvers.map((s) => `${s.id} → ${s.missing.join(", ")}`),
  );
  section(
    "Vanished approved capabilities (approved, but all resolvers are gone — propose removal):",
    vanishedApproved,
  );
  section("Dead code anchors (file no longer exists):", deadAnchors.map((d) => `${d.id} → ${d.file}`));
  section(
    "New resolvers not in the map (run `fmap build` to draft them):",
    newResolvers,
  );

  if (drift === 0) {
    console.log("✓ No drift — the map matches the code.");
    process.exitCode = 0;
  } else {
    console.log(`\n✗ ${drift} drift item(s) found.`);
    process.exitCode = 1;
  }
}
