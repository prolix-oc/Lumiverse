import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";

export class MoonshotProvider extends OpenAICompatibleProvider {
  readonly name = "moonshot";
  readonly displayName = "Moonshot";
  readonly defaultUrl = "https://api.moonshot.ai/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
    // Kimi K2 Thinking is end-to-end trained to interleave chain-of-thought
    // with tool calls. Like DeepSeek it carries reasoning via `reasoning_content`
    // (streamed before `content`), which the inherited
    // OpenAICompatibleProvider.flattenForChat echoes back on assistant tool-call
    // turns — so the generation loop's structured continuation keeps the model
    // reasoning across tool calls. Enable thinking + history retention by passing
    // `thinking: { type: "enabled", keep: "all" }` (sent via param passthrough);
    // Moonshot recommends max_tokens >= 16000 and temperature = 1.0 for K2.
    interleavedThinking: true,
  };
}
