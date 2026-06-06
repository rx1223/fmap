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
  .version("0.1.0")
  // On any usage error (unknown command, missing arg), point to help.
  .showHelpAfterError("(run `fmap --help` to see all commands)")
  // Append a quick-start so the help itself guides a first-time user.
  .addHelpText(
    "after",
    [
      "",
      "Getting started:",
      "  $ fmap auth --claude   configure your LLM (Anthropic) key — stored globally, never in the repo",
      "  $ fmap init            scaffold ./feature-map in your project",
      "  $ fmap build           extract the capability map (everything starts status: pending)",
      "  $ fmap query <text>    find a capability + how to reach it",
      "",
      "Run `fmap <command> --help` for details on a command.",
    ].join("\n"),
  );

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
  .option("--serve", "run as a local MCP server (stdio) exposing find_capability/get_anchor/list_capabilities/how_to_reach")
  .action((text, opts) => queryCommand(text, opts));

// Bare `fmap` (no args at all) → guide the user to the commands, exit 0.
// (Unknown commands still fall through to commander, which errors + hints.)
if (process.argv.slice(2).length === 0) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
