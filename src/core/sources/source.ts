import type { Operation } from "../operation.js";
import type { UsageResult } from "../frontend-ast.js";

/**
 * A capability source turns a project's backend surface into Operations and
 * knows how its operations appear in the frontend. GraphQL is one source; REST,
 * tRPC, and route handlers are peers. The pipeline never presupposes which one
 * a project uses — `fmap init` detects it, the config records it.
 */

/** Per-source config block, stored in feature-map.config.yaml under `sources`. */
export type SourceConfig = { type: string } & Record<string, unknown>;

export interface DetectionResult {
  /** The detected config block to write into the project config. */
  config: SourceConfig;
  /** One-line human summary shown during `fmap init`. */
  summary: string;
}

export interface CapabilitySource {
  /** Stable id matching SourceConfig.type, e.g. "graphql". */
  readonly id: string;
  /** Human title, e.g. "GraphQL". */
  readonly title: string;

  /** Auto-detect whether this source applies to the project (tier-1). */
  detect(projectRoot: string): DetectionResult | null;

  /** Produce the operation inventory from the configured source. */
  loadOperations(config: SourceConfig, projectRoot: string): Promise<Operation[]>;

  /** Scan the frontend for call-sites of these operations → mounts + pages. */
  scanUsage(operations: Operation[], frontendRoot: string, projectRoot: string): UsageResult;
}
