import { isInitialized } from "../config/project.js";
import { loadAllCapabilities, loadSitemap } from "../core/yaml-store.js";
import { pagePath } from "../core/sitemap.js";
import type { Capability, Sitemap } from "../core/model.js";

export interface QueryOptions {
  serve?: boolean;
}

/**
 * `fmap query [text]` — locate capabilities by name/object (the agent entry
 * point). Prints the node + anchor + how to reach it (path from the sitemap).
 * The map points you to WHERE; read the code at the anchor for the actual rule.
 */
export async function queryCommand(text: string | undefined, opts: QueryOptions): Promise<void> {
  if (opts.serve) {
    console.log(
      "query --serve: an MCP server (find_capability / get_anchor) is planned for the app phase — not implemented yet.",
    );
    return;
  }
  const cwd = process.cwd();
  if (!isInitialized(cwd)) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }
  const { caps } = loadAllCapabilities(cwd);
  const sitemap = loadSitemap(cwd);

  if (!caps.length) {
    console.log("The map is empty. Run `fmap build` first.");
    return;
  }
  if (!text || !text.trim()) {
    printSummary(caps);
    return;
  }

  const matches = search(caps, text.trim());
  if (!matches.length) {
    console.log(`No capability matches "${text}".`);
    console.log("Tip: this may be a blind spot. Solve it by reading code, then add it to the map (status: pending).");
    process.exitCode = 1;
    return;
  }
  console.log(`${matches.length} match${matches.length > 1 ? "es" : ""} for "${text}":\n`);
  for (const c of matches.slice(0, 8)) printCapability(c, sitemap);
}

function search(caps: Capability[], query: string): Capability[] {
  const q = query.toLowerCase();
  const scored = caps
    .map((c) => ({ c, score: scoreOf(c, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

function scoreOf(c: Capability, q: string): number {
  let score = 0;
  if (c.name.toLowerCase().includes(q)) score += 100;
  if (c.id.toLowerCase().includes(q)) score += 40;
  if (c.object.some((o) => o.toLowerCase().includes(q))) score += 30;
  if (c.statement.toLowerCase().includes(q)) score += 20;
  if ((c.operations ?? []).some((r) => r.toLowerCase().includes(q))) score += 15;
  // Deprioritise deprecated/unknown so live capabilities surface first.
  if (c.status === "deprecated") score -= 50;
  if (c.status === "unknown") score -= 5;
  return score;
}

function printCapability(c: Capability, sitemap: Sitemap): void {
  console.log(`● ${c.name}   [${c.id}]   (${c.status})`);
  console.log(`    ${c.statement}`);
  if (c.object.length) console.log(`    objects:   ${c.object.join(", ")}`);
  if (c.operations?.length) console.log(`    operations: ${c.operations.join(", ")}`);
  console.log(`    anchor:    ${c.code_anchor ?? "(none — follow the resolvers into the backend)"}`);
  if (c.mounted_on.length) {
    for (const pageId of c.mounted_on) {
      const path = pagePath(sitemap, pageId);
      if (path.length) console.log(`    reach:     ${path.map((p) => p.name).join("  ›  ")}`);
      else console.log(`    reach:     ${pageId} (page not in sitemap — run \`fmap build\`)`);
    }
  } else {
    console.log("    reach:     (no UI entry — backend/ops capability)");
  }
  console.log("");
}

function printSummary(caps: Capability[]): void {
  const by = (s: Capability["status"]) => caps.filter((c) => c.status === s);
  console.log(`${caps.length} capabilities:`);
  console.log(
    `  ✅ ${by("approved").length} approved · 🟡 ${by("pending").length} pending · ❓ ${by("unknown").length} unknown · 🚫 ${by("deprecated").length} deprecated`,
  );
  console.log("\nPass a search term, e.g. `fmap query 营业额` or `fmap query revenue`.");
  const named = caps.filter((c) => c.status !== "deprecated").slice(0, 20);
  if (named.length) {
    console.log("\nSome capabilities:");
    for (const c of named) console.log(`  - ${c.name}  [${c.id}]`);
  }
}
