import type { CapabilitySource, DetectionResult } from "./source.js";
import { graphqlSource } from "./graphql.js";
import { openapiSource } from "./openapi.js";
import { trpcSource } from "./trpc.js";

export type { CapabilitySource, DetectionResult, SourceConfig } from "./source.js";

/** All registered capability sources. Add new protocols here. */
export const ALL_SOURCES: CapabilitySource[] = [graphqlSource, openapiSource, trpcSource];

export function getSource(type: string): CapabilitySource | undefined {
  return ALL_SOURCES.find((s) => s.id === type);
}

export interface DetectedSource extends DetectionResult {
  id: string;
  title: string;
}

/** Run every source's detector against the project (tier-1 auto-detect). */
export function detectSources(projectRoot: string): DetectedSource[] {
  const out: DetectedSource[] = [];
  for (const s of ALL_SOURCES) {
    try {
      const d = s.detect(projectRoot);
      if (d) out.push({ ...d, id: s.id, title: s.title });
    } catch {
      /* a detector must never crash init */
    }
  }
  return out;
}
