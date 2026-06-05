/**
 * The LLM provider boundary. v0 ships Claude only; OpenAI/OpenRouter become
 * later additions behind this same interface with no caller changes.
 *
 * The semantic layer (re-slicing resolvers into capabilities, writing human
 * names + falsifiable statements) is the ONLY part that needs an LLM — and the
 * only part an operator must back. Everything else is deterministic.
 */

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  /** Stable identifier, e.g. "claude". */
  readonly name: string;
  /** The model id in use, for logging/audit. */
  readonly model: string;
  /** Single-shot completion returning concatenated text. */
  complete(opts: LlmCompleteOptions): Promise<string>;
}
