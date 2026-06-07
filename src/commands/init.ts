import prompts from "prompts";
import {
  defaultProjectConfig,
  detectFrontendRoot,
  isInitialized,
  scaffoldFeatureMap,
  featureMapDir,
  mcpConfigPath,
} from "../config/project.js";
import { fileExists } from "../core/fs-utils.js";
import { detectSources, type DetectedSource } from "../core/sources/index.js";
import type { SourceConfig } from "../core/sources/source.js";

export interface InitOptions {
  yes?: boolean;
  /** commander sets this false on `--no-skill`. */
  skill?: boolean;
}

const onCancel = () => {
  console.log("\nAborted — nothing scaffolded.");
  process.exit(1);
};

/**
 * `fmap init` — scaffold ./feature-map, auto-detect capability sources + frontend
 * (tier-1, no presupposed structure), and ask the tier-2 strategy knobs (each
 * defaulted). `-y` accepts all defaults.
 */
export async function initCommand(opts: InitOptions): Promise<void> {
  const cwd = process.cwd();

  if (isInitialized(cwd) && !opts.yes) {
    const { proceed } = await prompts(
      {
        type: "confirm",
        name: "proceed",
        message: "feature-map/ already exists. Re-detect and rewrite config? (existing capabilities are preserved)",
        initial: false,
      },
      { onCancel },
    );
    if (!proceed) {
      console.log("Nothing changed.");
      return;
    }
  }

  // ── Tier 1: auto-detect sources + frontend, present a default to review ──
  const detected = detectSources(cwd);
  const frontendRoot = detectFrontendRoot(cwd);
  console.log("Auto-detected (tier-1):");
  if (detected.length) {
    for (const d of detected) console.log(`    source        : ${d.summary}`);
  } else {
    console.log("    source        : (none found — add one under `sources:` in the config)");
  }
  console.log(`    frontend root : ${frontendRoot ?? "(none found — defaulting to src/)"}`);
  console.log("");

  // ── Tier 2: undetectable + project-dependent knobs, each with a default ──
  let strategy = defaultProjectConfig().strategy;
  if (!opts.yes) {
    const answers = await prompts(
      [
        {
          type: "select",
          name: "opsOnlyCapabilities",
          message: "Capabilities the backend exposes but the frontend never calls (ops-only / dead):",
          choices: [
            { title: "include & tag them (recommended)", value: "include_tagged" },
            { title: "exclude them", value: "exclude" },
          ],
          initial: 0,
        },
        {
          type: "select",
          name: "granularity",
          message: 'Capability granularity (is "buy / renew trial card" one capability or many?):',
          choices: [
            { title: "coarse — group by user-perceived feature (recommended)", value: "coarse" },
            { title: "fine — split aggressively by operation", value: "fine" },
          ],
          initial: 0,
        },
        {
          type: "confirm",
          name: "specialCrossEdges",
          message: "Build explicit edges for arbitrary (non-entity-hub) cross-jumps? (costs accuracy for effort)",
          initial: false,
        },
      ],
      { onCancel },
    );
    strategy = {
      opsOnlyCapabilities: answers.opsOnlyCapabilities ?? strategy.opsOnlyCapabilities,
      granularity: answers.granularity ?? strategy.granularity,
      specialCrossEdges: answers.specialCrossEdges ?? strategy.specialCrossEdges,
    };
  }

  const sources: SourceConfig[] = detected.map((d: DetectedSource) => d.config);

  const cfg = defaultProjectConfig({
    sources,
    frontend: frontendRoot ? { root: frontendRoot } : undefined,
    strategy,
  });

  const agentFiles = opts.skill !== false;
  const hadMcp = agentFiles && fileExists(mcpConfigPath(cwd));
  scaffoldFeatureMap(cfg, cwd, { agentFiles });

  console.log(`\n✓ Scaffolded ${featureMapDir(cwd)}`);
  console.log("    feature-map/");
  console.log("    ├── capabilities/        (capability YAML, one file per module)");
  console.log("    ├── generated/           (md views — do not edit; run `fmap render`)");
  console.log("    └── feature-map.config.yaml");
  if (agentFiles) {
    console.log("\nFor AI agents (committed, travel with the repo):");
    console.log("    .claude/skills/feature-map/SKILL.md   (teaches agents to use the map)");
    if (hadMcp) {
      console.log("    .mcp.json already exists — add this server entry to enable the MCP tools:");
      console.log('        "fmap": { "command": "npx", "args": ["-y", "capmap", "query", "--serve"] }');
    } else {
      console.log("    .mcp.json                             (registers the fmap MCP server)");
    }
    console.log("    (opt out with `fmap init --no-skill`)");
  }
  console.log("\nNext:");
  if (!sources.length) {
    console.log("  1. Add a capability source under `sources:` in feature-map/feature-map.config.yaml");
    console.log("     (e.g. - type: graphql / openapi / trpc / route)");
    console.log("  2. Run `fmap auth --claude` (if you haven't), then `fmap build`");
  } else {
    console.log("  1. Run `fmap auth --claude` (if you haven't)");
    console.log("  2. Run `fmap build` to extract a draft capability map");
  }
}
