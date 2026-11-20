import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import type { LlmMessage } from "../types";

export class ZAIProvider extends OpenAICompatibleProvider {
  readonly name = "zai";
  readonly displayName = "Z.AI";
  readonly defaultUrl = "https://api.z.ai/api/paas/v4";

  protected formatContent(message: LlmMessage): string | any[] {
    if (typeof message.content === "string") return message.content;
    return message.content.flatMap((part) => {
      if (part.type !== "video") return super.formatContent({ ...message, content: [part] });
      if (!["video/mp4", "video/quicktime", "video/x-matroska"].includes(part.mime_type)) {
        throw new Error("Z.AI video input requires MP4, MOV, or MKV.");
      }
      // Same private inline transport used by Z.ai's ZCode adapter. No public upload.
      return [{ type: "video_url", video_url: { url: `data:${part.mime_type};base64,${part.data}` } }];
    });
  }

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
    // GLM-4.5+ supports interleaved thinking by default: the model reasons
    // between tool calls and after receiving tool results.
    interleavedThinking: true,
  };

  // Z.AI does not expose an OpenAI-compatible /models endpoint (documented
  // endpoints are /chat/completions, image, video, audio, tools and agents).
  // Coding-plan keys in particular fail when /models is hit. Validate by
  // sending a minimal chat completion instead.
  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/chat/completions`, {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify({
          model: "glm-4.5-air",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.status === 401 || res.status === 403) return false;
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "authentication",
        detail: err instanceof Error ? err.message : "network request failed",
        retryable: true,
      });
    }
  }

  // Serve a static model list because the API has no /models endpoint.
  async listModels(_apiKey: string, _apiUrl: string): Promise<string[]> {
    return [
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "glm-5.3-flashx-legal",
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "glm-5-turbo",
      "glm-5",
      "glm-4.7",
      "glm-4.7-flash",
      "glm-4.7-flashx",
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-x",
      "glm-4.5-airx",
      "glm-4.5-flash",
      "glm-4-32b-0414-128k",
    ];
  }
}
