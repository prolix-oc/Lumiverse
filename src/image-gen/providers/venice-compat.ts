import { OpenAiCompatibleImageProvider } from "./openai-compatible-base";
import type { ImageGenRequest } from "../types";
import type { ImageProviderCapabilities } from "../param-schema";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/**
 * Venice AI image generation via its OpenAI-compatible surface.
 *
 * The compatibility endpoint mirrors OpenAI's Images shape but exposes fewer
 * features than Venice's native `/image/generate` API (see
 * {@link VeniceImageProvider} for the native path). Model sizing fields are
 * model-specific, so only `size` is forwarded when set.
 *
 * @see https://docs.venice.ai/guides/media/image-generation
 */
export class VeniceCompatImageProvider extends OpenAiCompatibleImageProvider {
  readonly name = "venice_compat";
  readonly displayName = "Venice AI (OpenAI-compatible)";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "1024x1024",
        description: "Output image dimensions, e.g. 1024x1024 (model-dependent)",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the request body",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    staticModels: [
      { id: "venice-sd35", label: "Venice SD 3.5" },
      { id: "flux-2-pro", label: "FLUX.2 Pro" },
    ],
    defaultUrl: "https://api.venice.ai/api/v1",
  };

  protected override buildExtraBody(request: ImageGenRequest): Record<string, any> {
    const params = request.parameters;
    const extra: Record<string, any> = {};
    if (params.seed != null && Number.isFinite(Number(params.seed))) extra.seed = Number(params.seed);
    return extra;
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    // Venice's `/models` is public, so the base-class check would accept any
    // key. `/api_keys/rate_limits` is authenticated and works for inference keys.
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/api_keys/rate_limits`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }
}
