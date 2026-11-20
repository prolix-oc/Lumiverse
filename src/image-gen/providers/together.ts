import { OpenAiCompatibleImageProvider } from "./openai-compatible-base";
import type { ImageGenRequest } from "../types";
import type { ImageProviderCapabilities } from "../param-schema";
import { asDataUrl, sourceImages } from "./shared";

/**
 * Together AI image generation (OpenAI-shaped `/images/generations`).
 *
 * Together's surface diverges from OpenAI in three documented ways: the inline
 * response format is `response_format: "base64"` (not `b64_json`), the output
 * size is `width`/`height` (FLUX.1 Pro/1.1 Pro/Dev) or `aspect_ratio` (Schnell,
 * Kontext), and it accepts `negative_prompt`. Both `data[].url` and
 * `data[].b64_json` responses are handled by the base class.
 *
 * @see https://docs.together.ai/docs/inference/images/overview
 * @see https://docs.together.ai/reference/post-images-generations
 */
export class TogetherImageProvider extends OpenAiCompatibleImageProvider {
  readonly name = "together";
  readonly displayName = "Together AI";

  constructor() {
    super({ responseFormat: "base64", supportsSize: false, supportsNegativePrompt: true });
  }

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "1024x1024",
        description: "Output size, e.g. 1024x1024 (sent as width/height)",
      },
      aspectRatio: {
        type: "select",
        default: "",
        description: "Use an aspect ratio instead of explicit width/height (Schnell / Kontext models)",
        options: [
          { id: "", label: "Explicit width/height" },
          { id: "1:1", label: "1:1 (Square)" },
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "4:3", label: "4:3" },
          { id: "3:4", label: "3:4" },
          { id: "3:2", label: "3:2" },
          { id: "2:3", label: "2:3" },
        ],
      },
      steps: {
        type: "integer",
        min: 1,
        max: 50,
        description: "Diffusion sampling steps",
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
      { id: "black-forest-labs/FLUX.2-dev", label: "FLUX.2 dev" },
      { id: "black-forest-labs/FLUX.1.1-pro", label: "FLUX 1.1 Pro" },
      { id: "black-forest-labs/FLUX.1-kontext-pro", label: "FLUX.1 Kontext Pro" },
      { id: "black-forest-labs/FLUX.2-pro", label: "FLUX.2 Pro" },
    ],
    defaultUrl: "https://api.together.xyz/v1",
  };

  protected override buildExtraBody(request: ImageGenRequest): Record<string, any> {
    const params = request.parameters;
    const extra: Record<string, any> = {};
    if (params.aspectRatio) extra.aspect_ratio = String(params.aspectRatio);
    else {
      const size = String(params.size || "");
      const [width, height] = size.split("x").map((v) => Number(v));
      if (Number.isFinite(width) && width > 0) extra.width = width;
      if (Number.isFinite(height) && height > 0) extra.height = height;
    }
    if (params.steps != null && Number.isFinite(Number(params.steps))) extra.steps = Number(params.steps);
    if (params.seed != null && Number.isFinite(Number(params.seed))) extra.seed = Number(params.seed);

    // Together takes edit/reference inputs as data URLs on `reference_images`
    // (FLUX.2, Gemini) or `image_url` (FLUX.1 Kontext). Both endpoints live on
    // `/images/generations`, so there is no multipart edit path to route to.
    const sources = sourceImages(params);
    if (sources.length > 0) {
      if (/kontext/i.test(request.model)) extra.image_url = asDataUrl(sources[0]);
      else extra.reference_images = sources.map((src) => asDataUrl(src));
    }
    return extra;
  }

  protected override isImageModel(id: string): boolean {
    return /(flux|stable-diffusion|sdxl|sd3|dall-e|gpt-image|imagen|kolors|ideogram|recraft|lumalabs|qwen-image|playground)/i.test(id);
  }
}
