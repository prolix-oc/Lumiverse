import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";

export class PollinationsProvider extends OpenAICompatibleProvider {
  readonly name = "pollinations";
  readonly displayName = "Pollinations";
  readonly defaultUrl = "https://gen.pollinations.ai/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    if (!apiKey) return false;
    try {
      const base = (apiUrl || this.defaultUrl).replace(/\/v1\/?$/, "").replace(/\/+$/, "");
      const res = await fetch(`${base}/account/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
