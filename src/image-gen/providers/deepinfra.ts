import { OpenAiCompatibleImageProvider } from "./openai-compatible-base";
import type { ImageGenRequest } from "../types";
import type { ImageProviderCapabilities } from "../param-schema";

/**
 * DeepInfra image generation via its OpenAI-compatible surface.
 *
 * DeepInfra returns `b64_json` only, so the base class's `response_format:
 * "b64_json"` is authoritative. `n` supports 1–4. `quality` / `style` are
 * accepted for compatibility only and are not forwarded. LoRA adapters are
 * reachable through the raw-request override.
 *
 * @see https://docs.deepinfra.com/apis/image-generation
 */
export class DeepInfraImageProvider extends OpenAiCompatibleImageProvider {
  readonly name = "deepinfra";
  readonly displayName = "DeepInfra";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "1024x1024",
        description: "Output image dimensions, e.g. 1024x1024 (model-dependent)",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the request body (e.g. LoRA adapters)",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    staticModels: [
      { id: "black-forest-labs/FLUX-1-schnell", label: "FLUX.1 schnell" },
      { id: "black-forest-labs/FLUX-1-dev", label: "FLUX.1 dev" },
    ],
    defaultUrl: "https://api.deepinfra.com/v1/openai",
  };

  protected override buildExtraBody(request: ImageGenRequest): Record<string, any> {
    const params = request.parameters;
    const extra: Record<string, any> = {};
    if (params.seed != null && Number.isFinite(Number(params.seed))) extra.seed = Number(params.seed);
    return extra;
  }

  protected override isImageModel(id: string): boolean {
    return /(flux|stable-diffusion|sdxl|sd3|dall-e|gpt-image|imagen|kolors|ideogram|recraft|qwen-image|playground|lora)/i.test(id);
  }
}
