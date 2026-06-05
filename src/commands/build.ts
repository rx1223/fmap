import { isInitialized, readProjectConfig } from "../config/project.js";
import { introspect, type ResolverInfo } from "../core/introspect.js";

export interface BuildOptions {
  dryRun?: boolean;
}

/**
 * `fmap build` — schema × frontend extraction → capability YAML (status: pending).
 * M1 wires deterministic introspection + `--dry-run` preview. The frontend
 * scan, four-quadrant classify, semantic draft and reconcile land in M2–M4.
 */
export async function buildCommand(opts: BuildOptions): Promise<void> {
  if (!isInitialized()) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }

  const cfg = readProjectConfig();
  const resolvers = await introspect(cfg);

  if (opts.dryRun) {
    printResolvers(resolvers);
    return;
  }

  console.log(`Introspected ${resolvers.length} resolvers.`);
  console.log("build: the semantic extraction pipeline lands in M3.");
  console.log("       Run `fmap build --dry-run` to preview the resolver list.");
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
      const flag = r.deprecated ? " [deprecated]" : "";
      console.log(`  ${r.name.padEnd(width)}→ ${types}${flag}`);
    }
  };

  section("QUERY", queries);
  section("MUTATION", mutations);
  console.log("\n(These are raw resolvers, not capabilities. `fmap build` re-slices them by business meaning.)");
}
