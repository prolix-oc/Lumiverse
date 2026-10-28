import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

export class ObscurifyProvider extends OpenAICompatibleProvider {
  readonly name = "obscurify";
  readonly displayName = "Obscurify.ai";
  readonly defaultUrl = "https://obscurify.ai/v1";

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
  };

  /** Statuses that mean the key passed auth and only the empty probe body was rejected. */
  private static readonly KEY_ACCEPTED_STATUSES = new Set([400, 404, 422]);

  /**
   * `/models` is public on Obscurify.ai, so it accepts any key. Send an empty
   * chat request instead: the auth layer answers 401/403 for a bad key before
   * the body is validated, and a good key gets a request-validation error
   * (400/404/422, e.g. `model_not_found`) without running a model. Any other
   * status (402, 429, 5xx) is surfaced instead of being reported as success.
   */
  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/chat/completions`, {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify({ model: "", messages: [] }),
      });
      if (!res.ok && !ObscurifyProvider.KEY_ACCEPTED_STATUSES.has(res.status)) {
        await throwProviderResponseError(this.displayName, "authentication", res);
      }
      return true;
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
}
