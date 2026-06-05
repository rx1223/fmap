import prompts from "prompts";
import {
  type ProjectConfig,
  defaultProjectConfig,
  detectProject,
  isInitialized,
  scaffoldFeatureMap,
  featureMapDir,
} from "../config/project.js";

export interface InitOptions {
  yes?: boolean;
}

const onCancel = () => {
  console.log("\nAborted — nothing scaffolded.");
  process.exit(1);
};

/**
 * `fmap init` — scaffold ./feature-map, auto-detect schema + frontend (tier-1),
 * and ask the tier-2 strategy knobs (each defaulted). `-y` accepts all defaults.
 */
export async function initCommand(opts: InitOptions): Promise<void> {
  const cwd = process.cwd();

  if (isInitialized(cwd) && !opts.yes) {
    const { proceed } = await prompts(
      {
        type: "confirm",
        name: "proceed",
        message:
          "feature-map/ already exists. Re-detect and rewrite config? (existing capabilities are preserved)",
        initial: false,
      },
      { onCancel },
    );
    if (!proceed) {
      console.log("Nothing changed.");
      return;
    }
  }

  // ── Tier 1: auto-detect, present a default the user reviews ──────────────
  const detected = detectProject(cwd);
  console.log("Auto-detected (tier-1):");
  const schemaLine =
    detected.sdlPath ??
    detected.endpointGuess ??
    "(none found — set schema.sdlPath or schema.endpoint in the config)";
  console.log(`    schema        : ${schemaLine}`);
  console.log(`    frontend root : ${detected.frontendRoot ?? "(none found — defaulting to src/)"}`);
  console.log("");

  // ── Tier 2: undetectable + project-dependent knobs, each with a default ──
  let strategy = defaultProjectConfig().strategy;
  if (!opts.yes) {
    const answers = await prompts(
      [
        {
          type: "select",
          name: "opsOnlyCapabilities",
          message: "Capabilities the schema exposes but the frontend never calls (ops-only / dead):",
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

  const schema: ProjectConfig["schema"] = detected.sdlPath
    ? { sdlPath: detected.sdlPath }
    : detected.endpointGuess
      ? { endpoint: detected.endpointGuess }
      : {};

  const cfg = defaultProjectConfig({
    schema,
    frontend: detected.frontendRoot ? { root: detected.frontendRoot } : undefined,
    strategy,
  });

  scaffoldFeatureMap(cfg, cwd);

  console.log(`\n✓ Scaffolded ${featureMapDir(cwd)}`);
  console.log("    feature-map/");
  console.log("    ├── capabilities/        (capability YAML, one file per module)");
  console.log("    ├── generated/           (md views — do not edit; run `fmap render`)");
  console.log("    └── feature-map.config.yaml");
  console.log("\nNext:");
  if (!detected.sdlPath && !detected.endpointGuess) {
    console.log("  1. Set schema.sdlPath or schema.endpoint in feature-map/feature-map.config.yaml");
    console.log("  2. Run `fmap auth --claude` (if you haven't), then `fmap build`");
  } else {
    console.log("  1. Run `fmap auth --claude` (if you haven't)");
    console.log("  2. Run `fmap build` to extract a draft capability map");
  }
}
