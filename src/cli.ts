#!/usr/bin/env node
import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { initCommand } from "./commands/init.js";
import { buildCommand } from "./commands/build.js";
import { checkCommand } from "./commands/check.js";
import { renderCommand } from "./commands/render.js";
import { queryCommand } from "./commands/query.js";

const program = new Command();

program
  .name("fmap")
  .description(
    "Extract a feature capability map from a codebase: what a system can do, where it lives, and how to reach it.",
  )
  .version("0.1.0");

program
  .command("auth")
  .description("Configure the LLM platform + credentials GLOBALLY (XDG).")
  .option("--claude", "use Claude (the default and only provider in v0)")
  .action((opts) => authCommand(opts));

program
  .command("init")
  .description("Scaffold ./feature-map, auto-detect schema/frontend, ask tier-2 knobs.")
  .option("-y, --yes", "accept all detected defaults without prompting")
  .action((opts) => initCommand(opts));

program
  .command("build")
  .description("Run schema × frontend extraction → capability YAML (status: pending).")
  .option("--dry-run", "print what would be extracted without writing YAML")
  .action((opts) => buildCommand(opts));

program
  .command("check")
  .description("Drift detection between the map and code (read-only; exits non-zero on drift).")
  .action(() => checkCommand());

program
  .command("render")
  .description("Generate md views from YAML into feature-map/generated/.")
  .action(() => renderCommand());

program
  .command("query")
  .argument("[text]", "capability name or object to locate")
  .description("Locate capabilities by name/object (agent entry point).")
  .option("--serve", "run as an MCP server exposing find_capability/get_anchor (stub)")
  .action((text, opts) => queryCommand(text, opts));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
