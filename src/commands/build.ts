import { isInitialized } from "../config/project.js";

export interface BuildOptions {
  dryRun?: boolean;
}

/**
 * `fmap build` — schema × frontend extraction → capability YAML (status: pending).
 * (Pipeline implemented in M1–M4; M0 only wires the init guard.)
 */
export async function buildCommand(opts: BuildOptions): Promise<void> {
  if (!isInitialized()) {
    console.error("No feature-map found in this project.\n  → Run `fmap init` first.");
    process.exitCode = 1;
    return;
  }
  console.log(`build: extraction pipeline not implemented yet (M1–M4).${opts.dryRun ? " [--dry-run]" : ""}`);
}
