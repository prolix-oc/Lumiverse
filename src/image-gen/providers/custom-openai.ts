import { OpenAiCompatibleImageProvider } from "./openai-compatible-base";
import type { ImageGenRequest } from "../types";
import type { ImageProviderCapabilities } from "../param-schema";

/**
 * Generic OpenAI-compatible image provider.
 *
 * Points at any host exposing `POST {base}/images/generations` with the OpenAI
 * Images request/response shape (Together AI, xAI, Venice compat, Recraft,
 * DeepInfra, LiteLLM, reverse proxies, self-hosted gateways). Both `b64_json`
 * and `url` responses are handled.
 *
 * The API URL is user-supplied; the default is a placeholder that the UI
 * replaces, so an unconfigured connection fails fast rather than silently
 * hitting an unrelated endpoint.
 */
export class CustomOpenAiImageProvider extends OpenAiCompatibleImageProvider {
  readonly name = "custom_openai";
  readonly displayName = "Custom (OpenAI-compatible image)";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "1024x1024",
        description: "Output image dimensions, e.g. 1024x1024 (model-dependent; leave blank to use the provider default)",
      },
      steps: {
        type: "integer",
        min: 1,
        max: 100,
        description: "Diffusion sampling steps (only sent when the provider/model accepts it)",
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      negative_prompt: {
        type: "string",
        description: "Optional negative prompt (only sent when the provider supports it)",
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
    staticModels: [],
    defaultUrl: "https://api.example.com/v1",
  };

  protected override buildExtraBody(request: ImageGenRequest): Record<string, any> {
    const params = request.parameters;
    const extra: Record<string, any> = {};
    if (params.steps != null && Number.isFinite(Number(params.steps))) extra.steps = Number(params.steps);
    if (params.seed != null && Number.isFinite(Number(params.seed))) extra.seed = Number(params.seed);
    if (params.negative_prompt) extra.negative_prompt = String(params.negative_prompt);
    return extra;
  }
}
