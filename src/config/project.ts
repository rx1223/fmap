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

// Agent-readiness files (committed; travel with the repo so downstream agents inherit them).
export function skillPath(cwd = process.cwd()): string {
  return path.join(cwd, ".claude", "skills", "feature-map", "SKILL.md");
}
export function mcpConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, ".mcp.json");
}

const SKILL_MD = `---
name: feature-map
description: >-
  Locate a product capability in this codebase and how to reach it — use when
  asked "where is X", "how do I get to / reach Y", "what can this app do",
  "which page shows Z", or before grepping the repo for a feature. The map says
  WHERE a feature lives and how to navigate to it; the real rules live in code.
---
# Feature Map

This project ships a feature-capability map at \`feature-map/*.yaml\` (built by fmap).

## The one rule
The map stores **WHERE, not HOW**. It tells you which capability exists, which
page exposes it, and a \`code_anchor\` to jump to. It NEVER stores limits,
thresholds, or business rules — those live in code. To answer "how many / what
limit / which condition", open the \`code_anchor\` and read the code. **Never
trust the map for a rule value.**

## How to use it
If the \`fmap\` MCP server is connected, prefer its tools:
\`find_capability\` → \`get_anchor\` → \`how_to_reach\` (and \`list_capabilities\`).
Otherwise use the CLI:
- \`fmap query <text>\` — matching capabilities + anchor + reach path
- \`fmap query\`        — a summary of all capabilities

Workflow: find_capability(text) → pick a capability → get_anchor(id) → open the
anchor file to read the ACTUAL implementation/rules → how_to_reach(id) for the
UI click-path. If nothing matches, it may be a blind spot: solve by reading code,
then a human can add it to the map as \`status: pending\`.
`;

// Server key stays "fmap" (what the agent calls it); the npx arg is the published package name.
const MCP_JSON = `${JSON.stringify({ mcpServers: { fmap: { command: "npx", args: ["-y", "featuremap", "query", "--serve"] } } }, null, 2)}\n`;

export interface ScaffoldOptions {
  /** Write the agent skill + .mcp.json (default true). */
  agentFiles?: boolean;
}

/** Scaffold feature-map/{capabilities,generated}/ + config (+ agent files). Idempotent. */
export function scaffoldFeatureMap(cfg: ProjectConfig, cwd = process.cwd(), opts: ScaffoldOptions = {}): void {
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

  if (opts.agentFiles === false) return;
  // Agent skill — never clobber a human-edited copy.
  const skill = skillPath(cwd);
  if (!fileExists(skill)) {
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, SKILL_MD);
  }
  // .mcp.json — write only if absent; never edit an existing (possibly multi-server) one.
  const mcp = mcpConfigPath(cwd);
  if (!fileExists(mcp)) fs.writeFileSync(mcp, MCP_JSON);
}

// ---------------------------------------------------------------------------
// Auto-detection (tier-1): frontend root. Source detection lives in the source
// registry (core/sources) so the config layer stays protocol-agnostic.
// ---------------------------------------------------------------------------

/** Best-effort detection of the frontend source root, never fatal. */
export function detectFrontendRoot(cwd: string = process.cwd()): string | undefined {
  // Monorepo apps/ first — the UI usually lives here, not in packages/ (libraries).
  const appUi = detectUiApp(cwd, "apps");
  if (appUi) return appUi;
  // Conventional single-app roots.
  const direct = firstExistingDir(cwd, ["src", "app", "frontend/src", "client/src", "web/src", "web", "frontend", "client"]);
  if (direct) return direct;
  // A UI app under packages/ before falling back to any packages/*/src library.
  const pkgUi = detectUiApp(cwd, "packages");
  if (pkgUi) return pkgUi;
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

/** Find a UI app under `<cwd>/<container>` — one with a UI dir + a UI-framework dep. */
function detectUiApp(cwd: string, container: string): string | undefined {
  const dir = path.join(cwd, container);
  if (!dirExists(dir)) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const appPath = path.join(dir, name);
    const hasUiDir =
      dirExists(path.join(appPath, "app")) ||
      dirExists(path.join(appPath, "src")) ||
      dirExists(path.join(appPath, "pages"));
    if (hasUiDir && hasUiDependency(appPath)) return path.join(container, name);
  }
  return undefined;
}

function hasUiDependency(appPath: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return ["react", "next", "vue", "svelte", "solid-js", "@angular/core", "vite", "astro"].some((d) => d in deps);
  } catch {
    return false;
  }
}
