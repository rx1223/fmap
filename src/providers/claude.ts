import Anthropic from "@anthropic-ai/sdk";
import type { LlmCompleteOptions, LlmProvider } from "./provider.js";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

/**
 * Claude implementation of LlmProvider. Sonnet is the default: this tool runs
 * bulk semantic classification over many resolvers, where Sonnet's speed/cost
 * balance fits. Override the model in `fmap auth` (e.g. opus for hard schemas).
 */
export class ClaudeProvider implements LlmProvider {
  readonly name = "claude";
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string = DEFAULT_CLAUDE_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(opts: LlmCompleteOptions): Promise<string> {
    // NB: annotate the result as Message. The SDK's create() has streaming
    // overloads that make a variable-typed param degrade the return to `any`;
    // annotating res keeps full type-safety on the content blocks below.
    //
    // `temperature` is sent ONLY when a caller explicitly sets it — newer
    // Claude models reject/deprecate it, and omitting it uses the model default.
    const res: Anthropic.Messages.Message = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
}
