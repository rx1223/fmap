import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";

/**
 * Global, user-level config — the LLM platform + (optionally) credentials.
 * Lives under $XDG_CONFIG_HOME/fmap (falling back to ~/.config/fmap), the
 * convention gh/stripe/kubectl use. Reused across all projects.
 *
 * SECURITY BOUNDARY: the API key must NEVER be written into a project's
 * feature-map/ — it can't be allowed to leak into a repo. Precedence on read
 * is env var first (recommended), then this file (only if the user opted in).
 */
export interface GlobalConfig {
  provider: "claude";
  model?: string;
  /** Only persisted on explicit opt-in; chmod 600 when present. */
  apiKey?: string;
}

export const ENV_API_KEY = "ANTHROPIC_API_KEY";

export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "fmap");
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.yaml");
}

export function readGlobalConfig(): GlobalConfig | null {
  const p = globalConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = YAML.parse(fs.readFileSync(p, "utf8")) as GlobalConfig | null;
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** Write config to the XDG path. Always chmod 600 — the file may hold a key. */
export function writeGlobalConfig(cfg: GlobalConfig): string {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = globalConfigPath();
  fs.writeFileSync(p, YAML.stringify(cfg), { mode: 0o600 });
  // Re-assert perms even if the file already existed with looser bits.
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  return p;
}

/** Resolve the API key: env var first (recommended), then the config file. */
export function resolveApiKey(cfg: GlobalConfig | null): string | undefined {
  const env = process.env[ENV_API_KEY];
  if (env && env.trim()) return env.trim();
  const stored = cfg?.apiKey;
  return stored && stored.trim() ? stored.trim() : undefined;
}
