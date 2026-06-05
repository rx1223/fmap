export interface QueryOptions {
  serve?: boolean;
}

/**
 * `fmap query [text]` — locate capabilities by name/object (agent entry point).
 * `--serve` will expose an MCP server later. (Implemented in M5.)
 */
export async function queryCommand(text: string | undefined, opts: QueryOptions): Promise<void> {
  if (opts.serve) {
    console.log("query --serve: MCP server not implemented yet (M5).");
    return;
  }
  console.log(`query: lookup not implemented yet (M5). (would search for: ${text ?? "<all>"})`);
}
