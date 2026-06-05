import { readGlobalConfig, resolveApiKey, ENV_API_KEY } from "../config/global.js";
import type { LlmProvider } from "./provider.js";
import { ClaudeProvider } from "./claude.js";

export type { LlmProvider } from "./provider.js";

/**
 * Build the configured provider, with actionable errors when setup is missing.
 * The key is resolved env-first; it is never read from the project repo.
 */
export function getProvider(): LlmProvider {
  const cfg = readGlobalConfig();
  if (!cfg) {
    throw new Error(
      "No LLM provider configured.\n  → Run `fmap auth --claude` to set one up.",
    );
  }
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new Error(
      `No API key found.\n` +
        `  → Set ${ENV_API_KEY} in your environment (recommended), or\n` +
        `  → run \`fmap auth --claude\` and opt in to storing the key.`,
    );
  }
  switch (cfg.provider) {
    case "claude":
      return new ClaudeProvider(key, cfg.model);
    default:
      throw new Error(
        `Unknown provider "${cfg.provider}" in global config.\n  → Re-run \`fmap auth\`.`,
      );
  }
}
