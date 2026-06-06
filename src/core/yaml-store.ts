import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Capability, Sitemap } from "./model.js";
import { capabilitiesDir, sitemapPath } from "../config/project.js";
import { walkFiles } from "./fs-utils.js";

/**
 * Load/save the capability YAML (one file per business module) and sitemap.yaml.
 * YAML is the SOURCE OF TRUTH — humans edit it directly. Machine fields are
 * refreshed by reconcile on each build; human fields are preserved.
 */

const CAP_FILE_HEADER =
  "# fmap capabilities — SOURCE OF TRUTH. Edit freely; this is what operators verify.\n" +
  "# On `fmap build`, machine fields (object, operations, mounted_on, code_anchor)\n" +
  "# are refreshed from code; human fields (name, statement, status) are preserved.\n" +
  "# status: approved | pending | unknown | deprecated  (only a human writes `approved`)\n\n";

/** kebab-case, filesystem-safe module slug. */
export function moduleSlug(module: string): string {
  const slug = module
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "misc";
}

export function moduleFilePath(module: string, cwd: string = process.cwd()): string {
  return path.join(capabilitiesDir(cwd), `${moduleSlug(module)}.yaml`);
}

export function listCapabilityFiles(cwd: string = process.cwd()): string[] {
  const dir = capabilitiesDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return walkFiles(dir, { filter: (p) => p.endsWith(".yaml") || p.endsWith(".yml") }).sort();
}

export function readCapabilityFile(file: string): Capability[] {
  if (!fs.existsSync(file)) return [];
  const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) return [];
  return parsed.map(migrateCapability) as unknown as Capability[];
}

/** Tolerate the pre-rename `resolvers` field by reading it as `operations`. */
function migrateCapability(c: Record<string, unknown>): Record<string, unknown> {
  if (c && c.operations === undefined && Array.isArray(c.resolvers)) {
    const { resolvers, ...rest } = c;
    return { ...rest, operations: resolvers };
  }
  return c;
}

export interface LoadedCapabilities {
  caps: Capability[];
  /** capability id → absolute file it currently lives in. */
  fileOf: Map<string, string>;
  /** absolute file → capabilities in it. */
  byFile: Map<string, Capability[]>;
}

export function loadAllCapabilities(cwd: string = process.cwd()): LoadedCapabilities {
  const caps: Capability[] = [];
  const fileOf = new Map<string, string>();
  const byFile = new Map<string, Capability[]>();
  for (const file of listCapabilityFiles(cwd)) {
    const list = readCapabilityFile(file);
    byFile.set(file, list);
    for (const c of list) {
      caps.push(c);
      fileOf.set(c.id, file);
    }
  }
  return { caps, fileOf, byFile };
}

export function writeCapabilityFile(file: string, caps: Capability[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (caps.length === 0) {
    // Don't leave an empty array file lying around.
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  const sorted = [...caps].sort((a, b) => a.id.localeCompare(b.id));
  const doc = new YAML.Document(sorted.map(normalizeForYaml));
  fs.writeFileSync(file, CAP_FILE_HEADER + doc.toString());
}

/** Drop undefined keys and keep a stable field order for clean diffs. */
function normalizeForYaml(c: Capability): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    name: c.name,
    statement: c.statement,
    object: c.object ?? [],
    mounted_on: c.mounted_on ?? [],
  };
  if (c.code_anchor) out.code_anchor = c.code_anchor;
  if (c.operations && c.operations.length) out.operations = c.operations;
  out.status = c.status;
  out.source = c.source;
  return out;
}

/** Write a whole set of capabilities, grouped into files by the given module map. */
export function writeCapabilitiesByModule(
  groups: Map<string, Capability[]>,
  cwd: string = process.cwd(),
): void {
  for (const [module, caps] of groups) {
    writeCapabilityFile(moduleFilePath(module, cwd), caps);
  }
}

/**
 * Persist reconciled capabilities. Each keeps its EXISTING file (so a human's
 * file placement is honoured); brand-new ones go to their drafted module file.
 * Every touched file plus any previously-existing file is rewritten, so a file
 * emptied by deprecation/moves doesn't leave a stale copy.
 */
export function persistReconciled(
  caps: Capability[],
  fileOf: Map<string, string>,
  moduleById: Map<string, string>,
  previousFiles: Iterable<string>,
  cwd: string = process.cwd(),
): void {
  const byFile = new Map<string, Capability[]>();
  for (const cap of caps) {
    const file = fileOf.get(cap.id) ?? moduleFilePath(moduleById.get(cap.id) ?? "misc", cwd);
    const list = byFile.get(file) ?? [];
    list.push(cap);
    byFile.set(file, list);
  }
  for (const file of new Set<string>([...byFile.keys(), ...previousFiles])) {
    writeCapabilityFile(file, byFile.get(file) ?? []);
  }
}

// ── Sitemap ────────────────────────────────────────────────────────────────

const SITEMAP_HEADER =
  "# fmap sitemap — page nodes + special transitions + entity hubs (one graph, one file).\n" +
  "# Tree edges are implied by `parent`; entity-hub jumps come from the hub rule;\n" +
  "# only genuinely-arbitrary cross-jumps are listed under `transitions`.\n\n";

export function loadSitemap(cwd: string = process.cwd()): Sitemap {
  const p = sitemapPath(cwd);
  if (!fs.existsSync(p)) return { pages: [], transitions: [] };
  const parsed = YAML.parse(fs.readFileSync(p, "utf8")) as Partial<Sitemap> | null;
  return { pages: parsed?.pages ?? [], transitions: parsed?.transitions ?? [] };
}

export function saveSitemap(sitemap: Sitemap, cwd: string = process.cwd()): void {
  const p = sitemapPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const doc = new YAML.Document({
    pages: sitemap.pages,
    transitions: sitemap.transitions,
  } as unknown as Record<string, unknown>);
  fs.writeFileSync(p, SITEMAP_HEADER + doc.toString());
}
