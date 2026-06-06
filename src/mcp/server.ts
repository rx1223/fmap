import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isInitialized } from "../config/project.js";
import { loadAllCapabilities, loadSitemap } from "../core/yaml-store.js";
import { findCapabilities, resolveReach, capabilityById, type ResolvedCapability } from "../core/query-engine.js";
import type { Capability, Sitemap, CapabilityStatus } from "../core/model.js";

/**
 * `fmap query --serve` — a LOCAL stdio MCP server. It is a sibling frontend to
 * the CLI over the same engine (core/query-engine + yaml-store); it does NOT
 * shell out to the CLI. The agent spawns this process with the repo as cwd, and
 * the tools read the committed feature-map/*.yaml directly.
 *
 * It serves the MAP, never the code: every tool returns small structured JSON
 * (capability + code_anchor + reach). The agent then opens the code_anchor in
 * its own checkout to read the actual rules. All tools are READ-ONLY — promotion
 * to `approved` stays a human edit; an agent never mutates the map.
 *
 * stdout is the MCP transport — nothing here may print to stdout; diagnostics go
 * to stderr only.
 */

// ── Pure payload builders (exported for unit tests; no I/O) ──────────────────

export type ToolResult = { ok: true; data: unknown } | { ok: false; message: string };

const ANCHOR_NOTE = "The map says WHERE; open the code_anchor to read the actual implementation/rules.";

function toDTO(r: ResolvedCapability) {
  const c = r.capability;
  return {
    id: c.id,
    name: c.name,
    statement: c.statement,
    status: c.status,
    object: c.object,
    operations: c.operations ?? [],
    code_anchor: r.anchor,
    reach: r.reach.map(({ pageId, display, missing }) => ({ pageId, display, missing })),
    score: r.score,
  };
}

export function buildFindPayload(caps: Capability[], sitemap: Sitemap, text: string): ToolResult {
  const matches = findCapabilities(caps, sitemap, text).slice(0, 8).map(toDTO);
  return { ok: true, data: { query: text, count: matches.length, matches, note: ANCHOR_NOTE } };
}

export function buildAnchorPayload(caps: Capability[], id: string): ToolResult {
  const c = capabilityById(caps, id);
  if (!c) return { ok: false, message: `No capability with id "${id}". Use find_capability or list_capabilities first.` };
  return {
    ok: true,
    data: {
      id: c.id,
      name: c.name,
      code_anchor: c.code_anchor ?? null,
      operations: c.operations ?? [],
      note: c.code_anchor ? ANCHOR_NOTE : "No code anchor — follow the operations into the backend to read the rules.",
    },
  };
}

export function buildListPayload(caps: Capability[], status?: CapabilityStatus): ToolResult {
  const list = caps
    .filter((c) => (status ? c.status === status : c.status !== "deprecated"))
    .map((c) => ({ id: c.id, name: c.name, status: c.status, statement: c.statement }));
  return { ok: true, data: { count: list.length, capabilities: list } };
}

export function buildReachPayload(caps: Capability[], sitemap: Sitemap, id: string): ToolResult {
  const c = capabilityById(caps, id);
  if (!c) return { ok: false, message: `No capability with id "${id}".` };
  const reach = resolveReach(sitemap, c).map(({ pageId, display, missing }) => ({ pageId, display, missing }));
  return {
    ok: true,
    data: reach.length
      ? { id: c.id, name: c.name, reach }
      : { id: c.id, name: c.name, reach: [], note: "No UI entry — this is a backend/ops capability." },
  };
}

// ── The stdio server ─────────────────────────────────────────────────────────

interface ContentResult {
  // The SDK's CallToolResult is an open/extensible shape (index signature), so
  // ours must allow extra keys to be assignable to it.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export async function serveMcp(cwd: string = process.cwd()): Promise<void> {
  const server = new McpServer({ name: "fmap", version: "0.1.0" });

  const notInitialized = (): ContentResult | null =>
    isInitialized(cwd)
      ? null
      : {
          isError: true,
          content: [{ type: "text", text: "No feature-map in this project. Run `fmap init` then `fmap build` first." }],
        };

  const load = () => ({ caps: loadAllCapabilities(cwd).caps, sitemap: loadSitemap(cwd) });

  const respond = (r: ToolResult): ContentResult =>
    r.ok
      ? { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] }
      : { isError: true, content: [{ type: "text", text: r.message }] };

  server.registerTool(
    "find_capability",
    {
      title: "Find a capability",
      description:
        "Locate product capabilities by name / object / keyword. Returns each capability's statement, status, operations, code_anchor (where to read the real rules) and reach (how to navigate there). The map says WHERE; open the code_anchor to read HOW.",
      inputSchema: { text: z.string().describe('name/object/keyword to locate, e.g. "revenue" or "营业额"') },
    },
    async ({ text }) => notInitialized() ?? respond(buildFindPayload(load().caps, load().sitemap, text)),
  );

  server.registerTool(
    "get_anchor",
    {
      title: "Get a capability's code anchor",
      description:
        "Return the code_anchor (file#symbol) for a capability id — the place to open and read the actual implementation/rules. Rules/limits live in code, never in the map.",
      inputSchema: { id: z.string().describe('capability id, e.g. "cap.purchase_trial_card"') },
    },
    async ({ id }) => notInitialized() ?? respond(buildAnchorPayload(load().caps, id)),
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description: "List capabilities (id, name, status, statement). Optionally filter by status. Orientation/discovery entry point.",
      inputSchema: {
        status: z.enum(["approved", "pending", "unknown", "deprecated"]).optional().describe("optional status filter"),
      },
    },
    async ({ status }) => notInitialized() ?? respond(buildListPayload(load().caps, status)),
  );

  server.registerTool(
    "how_to_reach",
    {
      title: "How to reach a capability",
      description: "Return the UI navigation path(s) to a capability id (root → page chains). Empty for backend/ops capabilities with no UI entry.",
      inputSchema: { id: z.string().describe("capability id") },
    },
    async ({ id }) => notInitialized() ?? respond(buildReachPayload(load().caps, load().sitemap, id)),
  );

  // stdout is the transport — connect and let it run.
  await server.connect(new StdioServerTransport());
}
