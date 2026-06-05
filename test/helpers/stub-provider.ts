import type { LlmProvider, LlmCompleteOptions } from "../../src/providers/provider.js";

/** A deterministic LlmProvider for tests — returns a canned string (or a fn of the options). */
export class StubProvider implements LlmProvider {
  readonly name = "stub";
  readonly model = "stub-model";
  public lastOptions: LlmCompleteOptions | undefined;
  constructor(private response: string | ((opts: LlmCompleteOptions) => string)) {}
  async complete(opts: LlmCompleteOptions): Promise<string> {
    this.lastOptions = opts;
    return typeof this.response === "function" ? this.response(opts) : this.response;
  }
}
