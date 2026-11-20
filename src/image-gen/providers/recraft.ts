import { OpenAiCompatibleImageProvider } from "./openai-compatible-base";
import type { ImageGenRequest } from "../types";
import type { ImageProviderCapabilities } from "../param-schema";

/**
 * Recraft image generation via its OpenAI-compatible surface.
 *
 * Works with the OpenAI SDK pointed at `https://external.api.recraft.ai/v1`.
 * `response_format` accepts `url`, `b64_json`, or `multipart`; the base class
 * requests `b64_json` for a durable result. Recraft also exposes vector (SVG)
 * and raster sub-endpoints, reachable through the raw-request override.
 *
 * @see https://www.recraft.ai/docs/api-reference/endpoints
 */
export class RecraftImageProvider extends OpenAiCompatibleImageProvider {
  readonly name = "recraft";
  readonly displayName = "Recraft";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "1024x1024",
        description: "Output image dimensions, e.g. 1024x1024 (model-dependent)",
      },
      style: {
        type: "string",
        description: "Optional Recraft style id (leave blank for the model default)",
        group: "advanced",
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
      { id: "recraftv4_1", label: "Recraft V4.1" },
      { id: "recraftv4", label: "Recraft V4" },
      { id: "recraftv4_pro", label: "Recraft V4 Pro" },
      { id: "recraftv3", label: "Recraft V3" },
      { id: "recraftv2", label: "Recraft V2" },
    ],
    defaultUrl: "https://external.api.recraft.ai/v1",
  };

  protected override buildExtraBody(request: ImageGenRequest): Record<string, any> {
    const params = request.parameters;
    const extra: Record<string, any> = {};
    if (params.style) extra.style = String(params.style);
    if (params.seed != null && Number.isFinite(Number(params.seed))) extra.seed = Number(params.seed);
    return extra;
  }
}
