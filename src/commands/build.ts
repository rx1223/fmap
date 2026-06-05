import path from "node:path";
import { isInitialized, readProjectConfig } from "../config/project.js";
import { dirExists } from "../core/fs-utils.js";
import { unique } from "../core/util.js";
import { getSource } from "../core/sources/index.js";
import { classify, quadrantCounts, type ClassifiedOperation } from "../core/classify.js";
import type { CallSite, DiscoveredPage, UnresolvedSite } from "../core/frontend-ast.js";
import { extractCapabilities } from "../core/extract.js";
import { reconcile } from "../core/reconcile.js";
import { loadAllCapabilities, persistReconciled, loadSitemap, saveSitemap } from "../core/yaml-store.js";
import { buildSitemap } from "../core/sitemap.js";
import { getProvider } from "../providers/index.js";

export interface BuildOptions {
  dryRun?: boolean;
}

/**
 * `fmap build` — backend × frontend extraction → capability YAML (status: pending).
 * For each configured source: load operations → scan frontend usage → classify.
 * Then (across all sources): LLM re-slice → reconcile with existing YAML → sitemap.
 */
export async function buildCommand(opts: BuildOptions): Promise<void> {
  const cwd = process.cwd();
  if (!isInitialized(cwd)) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }

  const cfg = readProjectConfig(cwd);
  if (!cfg.sources.length) {
    console.error(
      "No capability sources configured.\n  → Run `fmap init` (auto-detect) or add a source under `sources:` in feature-map.config.yaml.",
    );
    process.exitCode = 1;
    return;
  }

  const frontendRoot = path.resolve(cwd, cfg.frontend.root);
  if (!dirExists(frontendRoot)) {
    console.warn(`Warning: frontend root "${cfg.frontend.root}" not found — every operation will be treated as having no UI entry.`);
  }

  const classified: ClassifiedOperation[] = [];
  const sites: CallSite[] = [];
  const unresolved: UnresolvedSite[] = [];
  const pages: DiscoveredPage[] = [];

  for (const sc of cfg.sources) {
    const source = getSource(sc.type);
    if (!source) {
      console.warn(`Warning: unknown source type "${sc.type}" — skipping. (known: graphql, …)`);
      continue;
    }
    try {
      const operations = await source.loadOperations(sc, cwd);
      const usage = source.scanUsage(operations, frontendRoot, cwd);
      classified.push(...classify(operations, usage));
      sites.push(...usage.sites);
      unresolved.push(...usage.unresolved);
      pages.push(...usage.pages);
      if (opts.dryRun) console.log(`source "${source.id}": ${operations.length} operations, ${usage.sites.length} call-sites resolved`);
    } catch (e) {
      console.warn(`Warning: source "${sc.type}" failed — ${(e as Error).message}`);
    }
  }

  if (classified.length === 0) {
    console.error("No operations found from any source. Check your `sources` config.");
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    printUsage(sites, unresolved);
    printQuadrants(classified);
    console.log("\n(--dry-run: no LLM call, no YAML written.)");
    return;
  }

  const provider = getProvider(); // throws an actionable error if unconfigured
  console.log(`Extracting capabilities with ${provider.name} (${provider.model})…`);
  const drafts = await extractCapabilities({ classified, sites, config: cfg, provider });

  // Reconcile against what's already on disk — never clobber human edits.
  const loaded = loadAllCapabilities(cwd);
  const draftModuleById = new Map(drafts.map((d) => [d.id, d.module]));
  const result = reconcile(
    loaded.caps,
    drafts.map(({ module: _m, ...cap }) => cap),
  );
  persistReconciled(result.caps, loaded.fileOf, draftModuleById, loaded.byFile.keys(), cwd);

  // Sitemap (deterministic, no LLM): pages + tree + entity hubs from the frontend.
  const entityTypes = unique(classified.flatMap((c) => c.operation.entities));
  const sitemap = buildSitemap({ pages, entityTypes, frontendRoot, projectRoot: cwd, existing: loadSitemap(cwd) });
  saveSitemap(sitemap, cwd);

  const counts = quadrantCounts(classified);
  console.log(`\n✓ feature-map/capabilities/ updated.`);
  console.log(
    `  +${result.added.length} new · ~${result.updated.length} refreshed · =${result.unchanged.length} unchanged · ⊘${result.deprecated.length} deprecated`,
  );
  console.log(
    `  quadrants: ${counts.user_capability} user · ${counts.no_entry} no-entry · ${counts.unknown} unknown · ${counts.noise} noise(dropped)`,
  );
  console.log(`  sitemap: ${sitemap.pages.length} page(s), ${sitemap.transitions.length} special transition(s) → feature-map/sitemap.yaml`);
  console.log("  new entries are status: pending — a human approves by editing YAML; human edits are preserved.");
}

function printUsage(sites: CallSite[], unresolved: UnresolvedSite[]): void {
  console.log(`\nFrontend call-sites: ${sites.length} resolved, ${unresolved.length} UNRESOLVED`);
  if (sites.length) {
    console.log("\nOPERATION → PAGE (mounts, free from call-sites)");
    const width = Math.min(28, Math.max(...sites.map((s) => s.operation.length)) + 2);
    for (const s of sites) console.log(`  ${s.operation.padEnd(width)}→ ${s.pageName}  (${s.file})`);
  }
  if (unresolved.length) {
    console.log("\nUNRESOLVED (held as blind spots — never force-guessed)");
    for (const u of unresolved) console.log(`  • ${u.reason}\n      ${u.file}: ${u.snippet}`);
  }
}

function printQuadrants(classified: ClassifiedOperation[]): void {
  const counts = quadrantCounts(classified);
  console.log(
    `\nFour-quadrant classification: ${counts.user_capability} user_capability · ` +
      `${counts.no_entry} no_entry · ${counts.unknown} unknown · ${counts.noise} noise`,
  );
  for (const q of ["user_capability", "no_entry", "unknown", "noise"] as const) {
    const names = classified.filter((c) => c.quadrant === q).map((c) => c.operation.name);
    if (names.length) console.log(`  ${q.padEnd(16)} ${names.join(", ")}`);
  }
}
