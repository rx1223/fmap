import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import { dirExists, fileExists, firstExistingDir } from "../core/fs-utils.js";
import type { SourceConfig } from "../core/sources/source.js";

/**
 * Project-level config — committed, travels with the code so map changes ride
 * the same PR. Holds the capability sources, frontend root, and tier-2 strategy
 * knobs (all defaulted). Source-agnostic: GraphQL is just one entry in
 * `sources`. NEVER holds credentials.
 */

export const FEATURE_MAP_DIR = "feature-map";
export const CONFIG_FILENAME = "feature-map.config.yaml";

/** Whether ops-only capabilities (backend has it, frontend doesn't) are kept. */
export type OpsOnlyPolicy = "include_tagged" | "exclude";
/** "购买/续费体验卡" as one capability (coarse) or many (fine). */
export type Granularity = "coarse" | "fine";

export interface ProjectConfig {
  /** Capability sources — GraphQL / OpenAPI / tRPC / route handlers / … */
  sources: SourceConfig[];
  frontend: {
    /** Frontend source root, relative to project root. */
    root: string;
  };
  /** Tier-2 knobs — undetectable + project-dependent, every one defaulted. */
  strategy: {
    opsOnlyCapabilities: OpsOnlyPolicy;
    granularity: Granularity;
    /** Build explicit edges for arbitrary (non-entity-hub) cross-jumps? */
    specialCrossEdges: boolean;
  };
}

export function defaultProjectConfig(detected?: Partial<ProjectConfig>): ProjectConfig {
  return {
    sources: detected?.sources ?? [],
    frontend: {
      root: detected?.frontend?.root ?? "src",
    },
    strategy: {
      opsOnlyCapabilities: detected?.strategy?.opsOnlyCapabilities ?? "include_tagged",
      granularity: detected?.strategy?.granularity ?? "coarse",
      specialCrossEdges: detected?.strategy?.specialCrossEdges ?? false,
    },
  };
}

export function featureMapDir(cwd = process.cwd()): string {
  return path.join(cwd, FEATURE_MAP_DIR);
}

export function capabilitiesDir(cwd = process.cwd()): string {
  return path.join(featureMapDir(cwd), "capabilities");
}

export function generatedDir(cwd = process.cwd()): string {
  return path.join(featureMapDir(cwd), "generated");
}

export function sitemapPath(cwd = process.cwd()): string {
  return path.join(featureMapDir(cwd), "sitemap.yaml");
}

export function projectConfigPath(cwd = process.cwd()): string {
  return path.join(featureMapDir(cwd), CONFIG_FILENAME);
}

export function isInitialized(cwd = process.cwd()): boolean {
  return fileExists(projectConfigPath(cwd));
}

export function readProjectConfig(cwd = process.cwd()): ProjectConfig {
  const p = projectConfigPath(cwd);
  if (!fileExists(p)) {
    throw new Error(
      `No feature-map found in this project. Run \`fmap init\` first.`,
    );
  }
  const parsed = (YAML.parse(fs.readFileSync(p, "utf8")) ?? {}) as Record<string, unknown>;
  // Migrate the pre-sources shape: { schema: {...} } → sources: [{ type:"graphql", ... }].
  if (!parsed.sources && parsed.schema && typeof parsed.schema === "object") {
    parsed.sources = [{ type: "graphql", ...(parsed.schema as Record<string, unknown>) }];
  }
  // Merge over defaults so older/partial configs stay valid.
  return defaultProjectConfig(parsed as Partial<ProjectConfig>);
}

export function writeProjectConfig(cfg: ProjectConfig, cwd = process.cwd()): void {
  fs.mkdirSync(featureMapDir(cwd), { recursive: true });
  fs.writeFileSync(projectConfigPath(cwd), renderConfigYaml(cfg));
}

/** Render config with explanatory comments — humans read & edit this file. */
function renderConfigYaml(cfg: ProjectConfig): string {
  const doc = new YAML.Document(cfg as unknown as Record<string, unknown>);
  YAML.visit(doc, {}); // no-op, keeps types happy
  const header =
    "# fmap project config — committed, travels with the code.\n" +
    "# NEVER put credentials here; the API key lives in global config / env.\n" +
    "# `sources` lists the capability sources. Each has a `type` and its own\n" +
    "# fields, e.g.:\n" +
    "#   - type: graphql        # sdlPath: schema.graphql   OR   endpoint: https://…\n" +
    "#   - type: openapi        # specPath: openapi.yaml\n" +
    "#   - type: trpc           # routerPath: server/router.ts\n" +
    "#   - type: route          # root: server\n" +
    "# For any endpoint headers, give the ENV VAR NAME, not the value:\n" +
    "#   headers: { Authorization: MY_TOKEN_ENV_VAR }\n\n";
  return header + doc.toString();
}

/** Scaffold feature-map/{capabilities,generated}/ + config. Idempotent. */
export function scaffoldFeatureMap(cfg: ProjectConfig, cwd = process.cwd()): void {
  fs.mkdirSync(capabilitiesDir(cwd), { recursive: true });
  fs.mkdirSync(generatedDir(cwd), { recursive: true });
  writeProjectConfig(cfg, cwd);
  // Drop a .gitkeep so the empty capabilities dir is committable.
  const keep = path.join(capabilitiesDir(cwd), ".gitkeep");
  if (!fileExists(keep)) fs.writeFileSync(keep, "");
  // A note in generated/ so humans know not to edit it.
  const note = path.join(generatedDir(cwd), "README.md");
  if (!fileExists(note)) {
    fs.writeFileSync(
      note,
      "<!-- GENERATED by `fmap render` — do not edit. Edit the YAML in feature-map/ instead. -->\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Auto-detection (tier-1): frontend root. Source detection lives in the source
// registry (core/sources) so the config layer stays protocol-agnostic.
// ---------------------------------------------------------------------------

/** Best-effort detection of the frontend source root, never fatal. */
export function detectFrontendRoot(cwd: string = process.cwd()): string | undefined {
  // Common roots; pick the first that exists.
  const direct = firstExistingDir(cwd, ["src", "app", "frontend/src", "client/src", "web/src"]);
  if (direct) return direct;
  // Monorepo: look for packages/*/src.
  const pkgs = path.join(cwd, "packages");
  if (dirExists(pkgs)) {
    try {
      for (const e of fs.readdirSync(pkgs, { withFileTypes: true })) {
        if (e.isDirectory() && dirExists(path.join(pkgs, e.name, "src"))) {
          return path.join("packages", e.name, "src");
        }
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
