import path from "node:path";
import { isInitialized, readProjectConfig } from "../config/project.js";
import { dirExists } from "../core/fs-utils.js";
import { introspect, type ResolverInfo } from "../core/introspect.js";
import { getScanner, type ScanResult } from "../core/scan-frontend.js";
import { classify, quadrantCounts, type ClassifiedResolver } from "../core/classify.js";
import { extractCapabilities } from "../core/extract.js";
import { reconcile } from "../core/reconcile.js";
import { loadAllCapabilities, persistReconciled } from "../core/yaml-store.js";
import { getProvider } from "../providers/index.js";

export interface BuildOptions {
  dryRun?: boolean;
}

/**
 * `fmap build` — schema × frontend extraction → capability YAML (status: pending).
 * introspect (M1) → scan call-sites (M2) → four-quadrant classify + LLM
 * re-slice (M3) → reconcile with existing YAML (M4).
 */
export async function buildCommand(opts: BuildOptions): Promise<void> {
  const cwd = process.cwd();
  if (!isInitialized(cwd)) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }

  const cfg = readProjectConfig(cwd);
  const resolvers = await introspect(cfg, cwd);

  const frontendRoot = path.resolve(cwd, cfg.frontend.root);
  if (!dirExists(frontendRoot)) {
    console.warn(`Warning: frontend root "${cfg.frontend.root}" not found — every resolver will be treated as having no UI entry.`);
  }
  const scan = getScanner().scan(frontendRoot, cwd);
  const classified = classify(resolvers, scan);

  if (opts.dryRun) {
    printResolvers(resolvers);
    printScan(scan);
    printQuadrants(classified);
    console.log("\n(--dry-run: no LLM call, no YAML written.)");
    return;
  }

  const provider = getProvider(); // throws an actionable error if unconfigured
  console.log(`Extracting capabilities with ${provider.name} (${provider.model})…`);
  const drafts = await extractCapabilities({ resolvers, scan, config: cfg, provider });

  // Reconcile against what's already on disk — never clobber human edits.
  const loaded = loadAllCapabilities(cwd);
  const draftModuleById = new Map(drafts.map((d) => [d.id, d.module]));
  const result = reconcile(
    loaded.caps,
    drafts.map(({ module: _m, ...cap }) => cap),
  );
  persistReconciled(result.caps, loaded.fileOf, draftModuleById, loaded.byFile.keys(), cwd);

  const counts = quadrantCounts(classified);
  console.log(`\n✓ feature-map/capabilities/ updated.`);
  console.log(
    `  +${result.added.length} new · ~${result.updated.length} refreshed · =${result.unchanged.length} unchanged · ⊘${result.deprecated.length} deprecated`,
  );
  console.log(
    `  quadrants: ${counts.user_capability} user · ${counts.no_entry} no-entry · ${counts.unknown} unknown · ${counts.noise} noise(dropped)`,
  );
  console.log("  new entries are status: pending — a human approves by editing YAML; human edits are preserved.");
}

function printResolvers(resolvers: ResolverInfo[]): void {
  const queries = resolvers.filter((r) => r.kind === "query");
  const mutations = resolvers.filter((r) => r.kind === "mutation");
  const deprecated = resolvers.filter((r) => r.deprecated).length;
  console.log(
    `Schema: ${resolvers.length} resolvers — ${queries.length} queries, ${mutations.length} mutations` +
      (deprecated ? ` (${deprecated} deprecated)` : ""),
  );
  const section = (title: string, list: ResolverInfo[]) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    const width = Math.min(34, Math.max(...list.map((r) => r.name.length)) + 2);
    for (const r of list) {
      const types = r.objectTypes.length ? r.objectTypes.join(", ") : "—";
      console.log(`  ${r.name.padEnd(width)}→ ${types}${r.deprecated ? " [deprecated]" : ""}`);
    }
  };
  section("QUERY", queries);
  section("MUTATION", mutations);
}

function printScan(scan: ScanResult): void {
  console.log(`\nFrontend call-sites: ${scan.sites.length} resolved, ${scan.unresolved.length} UNRESOLVED`);
  if (scan.sites.length) {
    console.log("\nRESOLVER → PAGE (mounts, free from call-sites)");
    const width = Math.min(28, Math.max(...scan.sites.map((s) => s.resolver.length)) + 2);
    for (const s of scan.sites) console.log(`  ${s.resolver.padEnd(width)}→ ${s.pageName}  (${s.file})`);
  }
  if (scan.unresolved.length) {
    console.log("\nUNRESOLVED (held as blind spots — never force-guessed)");
    for (const u of scan.unresolved) console.log(`  • ${u.reason}\n      ${u.file}: ${u.snippet}`);
  }
}

function printQuadrants(classified: ClassifiedResolver[]): void {
  const counts = quadrantCounts(classified);
  console.log(
    `\nFour-quadrant classification: ${counts.user_capability} user_capability · ` +
      `${counts.no_entry} no_entry · ${counts.unknown} unknown · ${counts.noise} noise`,
  );
  for (const q of ["user_capability", "no_entry", "unknown", "noise"] as const) {
    const names = classified.filter((c) => c.quadrant === q).map((c) => c.resolver.name);
    if (names.length) console.log(`  ${q.padEnd(16)} ${names.join(", ")}`);
  }
}
