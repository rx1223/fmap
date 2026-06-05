import prompts from "prompts";
import {
  type GlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
  ENV_API_KEY,
} from "../config/global.js";
import { DEFAULT_CLAUDE_MODEL } from "../providers/claude.js";

export interface AuthOptions {
  claude?: boolean;
}

const onCancel = () => {
  console.log("\nAborted — no changes made.");
  process.exit(1);
};

/**
 * `fmap auth` — configure the LLM platform + credentials GLOBALLY (XDG).
 * Key precedence is env-first; storing to the config file is opt-in and
 * chmod 600. The key is never written into any project repo.
 */
export async function authCommand(opts: AuthOptions): Promise<void> {
  const provider: GlobalConfig["provider"] = "claude"; // v0 ships Claude only
  if (!opts.claude) {
    console.log("Configuring Claude (the only provider in v0).");
  }

  const existing = readGlobalConfig();
  const envKey = process.env[ENV_API_KEY];
  const envKeyPresent = !!(envKey && envKey.trim());

  const { model } = await prompts(
    {
      type: "select",
      name: "model",
      message: "Which Claude model should fmap use?",
      choices: [
        {
          title: "claude-sonnet-4-6  — fast & capable, good for bulk extraction (recommended)",
          value: "claude-sonnet-4-6",
        },
        {
          title: "claude-opus-4-8    — most capable, for hard/ambiguous schemas",
          value: "claude-opus-4-8",
        },
        {
          title: "claude-haiku-4-5   — fastest & cheapest",
          value: "claude-haiku-4-5-20251001",
        },
      ],
      initial: 0,
    },
    { onCancel },
  );

  let apiKey: string | undefined = existing?.apiKey;

  if (envKeyPresent) {
    console.log(`✓ Found ${ENV_API_KEY} in your environment — fmap will use it at runtime.`);
    const { persist } = await prompts(
      {
        type: "confirm",
        name: "persist",
        message: "Also store a key in the config file? (not needed — the env var is set)",
        initial: false,
      },
      { onCancel },
    );
    if (persist) {
      const { key } = await prompts(
        { type: "password", name: "key", message: "Paste the key to store (chmod 600):" },
        { onCancel },
      );
      if (key && key.trim()) apiKey = key.trim();
    }
  } else {
    const { key } = await prompts(
      {
        type: "password",
        name: "key",
        message: `Anthropic API key (blank → resolve from ${ENV_API_KEY} at runtime):`,
      },
      { onCancel },
    );
    if (key && key.trim()) {
      const { persist } = await prompts(
        {
          type: "confirm",
          name: "persist",
          message: "Store this key in the config file (chmod 600)?",
          initial: true,
        },
        { onCancel },
      );
      if (persist) apiKey = key.trim();
      else console.log(`Not stored. Export ${ENV_API_KEY} in your shell to use fmap.`);
    }
  }

  const cfg: GlobalConfig = { provider, model: (model as string) ?? DEFAULT_CLAUDE_MODEL };
  if (apiKey) cfg.apiKey = apiKey;
  const savedPath = writeGlobalConfig(cfg);

  console.log(`\n✓ Saved global config → ${savedPath}`);
  console.log(`    provider : ${provider}`);
  console.log(`    model    : ${cfg.model}`);
  console.log(
    `    api key  : ${apiKey ? "stored in config (chmod 600)" : `read from ${ENV_API_KEY} at runtime`}`,
  );
  console.log(
    `\nThe key is global and is NEVER written into any project's feature-map/ directory.`,
  );
}
