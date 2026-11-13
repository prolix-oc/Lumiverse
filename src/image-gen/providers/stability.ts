import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { decodeImage, sourceImages, trimBaseUrl } from "./shared";

/**
 * Stability AI image generation (`/v2beta/stable-image/generate/{ultra|core|sd3}`).
 *
 * These endpoints take `multipart/form-data` rather than JSON. `output_format`
 * is forced to `png` so the response is a data URL Lumiverse can store
 * directly; `Accept: application/json` returns the bytes base64-encoded in
 * `image` alongside a `finish_reason`.
 *
 * Image input: Ultra and SD3 accept an `image` part (SD3 additionally requires
 * `mode: image-to-image` and `strength`). Core has no image-to-image mode.
 *
 * @see https://docs.stability.ai/api-reference/generate/stable-image-core
 * @see https://docs.stability.ai/api-reference/generate/stable-image-ultra
 * @see https://docs.stability.ai/api-reference/generate/stable-diffusion-35
 */
export class StabilityImageProvider implements ImageProvider {
  readonly name = "stability";
  readonly displayName = "Stability AI";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "1:1",
        description: "Output aspect ratio (text-to-image only)",
        options: [
          { id: "1:1", label: "1:1 (Square)" },
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "3:2", label: "3:2" },
          { id: "2:3", label: "2:3" },
          { id: "5:4", label: "5:4" },
          { id: "4:5", label: "4:5" },
          { id: "21:9", label: "21:9" },
          { id: "9:21", label: "9:21" },
        ],
      },
      model: {
        type: "select",
        default: "",
        description: "SD3.5 model variant (only used by the `sd3` endpoint)",
        options: [
          { id: "", label: "sd3.5-large (default)" },
          { id: "sd3.5-large", label: "SD3.5 Large" },
          { id: "sd3.5-large-turbo", label: "SD3.5 Large Turbo" },
          { id: "sd3.5-medium", label: "SD3.5 Medium" },
          { id: "sd3.5-flash", label: "SD3.5 Flash" },
        ],
        group: "advanced",
      },
      outputFormat: {
        type: "select",
        default: "png",
        description: "Returned image format",
        options: [
          { id: "png", label: "PNG" },
          { id: "jpeg", label: "JPEG" },
          { id: "webp", label: "WebP" },
        ],
        group: "advanced",
      },
      stylePreset: {
        type: "select",
        default: "",
        description: "Style preset (core / ultra / sd3)",
        options: [
          { id: "", label: "None" },
          { id: "enhance", label: "Enhance" },
          { id: "anime", label: "Anime" },
          { id: "photographic", label: "Photographic" },
          { id: "digital-art", label: "Digital Art" },
          { id: "comic-book", label: "Comic Book" },
          { id: "fantasy-art", label: "Fantasy Art" },
          { id: "line-art", label: "Line Art" },
          { id: "analog-film", label: "Analog Film" },
          { id: "neon-punk", label: "Neon Punk" },
          { id: "isometric", label: "Isometric" },
          { id: "low-poly", label: "Low Poly" },
          { id: "origami", label: "Origami" },
          { id: "modeling-compound", label: "Modeling Compound" },
          { id: "cinematic", label: "Cinematic" },
          { id: "3d-model", label: "3D Model" },
          { id: "pixel-art", label: "Pixel Art" },
          { id: "tile-texture", label: "Tile Texture" },
        ],
        group: "advanced",
      },
      cfgScale: {
        type: "number",
        min: 1,
        max: 10,
        step: 0.5,
        description: "Prompt adherence (sd3 models)",
        group: "advanced",
      },
      strength: {
        type: "number",
        min: 0,
        max: 1,
        step: 0.05,
        description: "Denoising strength for image-to-image (ultra / sd3)",
        group: "advanced",
      },
      seed: {
        type: "integer",
        default: 0,
        description: "Random seed (0 = random)",
        group: "advanced",
      },
      negativePrompt: {
        type: "string",
        description: "What to avoid in the image (sd3 / ultra)",
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the multipart fields",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "core", label: "Stable Image Core" },
      { id: "ultra", label: "Stable Image Ultra" },
      { id: "sd3", label: "Stable Diffusion 3.5" },
    ],
    defaultUrl: "https://api.stability.ai",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/v2beta\/.*$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "core";
    const base = this.baseUrl(apiUrl);
    const sources = sourceImages(params);
    const acceptsImage = model === "ultra" || model === "sd3";

    const fields: Record<string, string> = {
      prompt: request.prompt,
      output_format: params.outputFormat || "png",
    };
    // `aspect_ratio` is text-to-image only; `image`/`strength` are image-to-image.
    if (sources.length === 0 && params.aspectRatio) fields.aspect_ratio = String(params.aspectRatio);
    if (request.negativePrompt || params.negativePrompt) {
      fields.negative_prompt = String(request.negativePrompt || params.negativePrompt);
    }
    if (params.stylePreset) fields.style_preset = String(params.stylePreset);
    if (model === "sd3") {
      if (params.cfgScale != null && Number.isFinite(Number(params.cfgScale))) fields.cfg_scale = String(params.cfgScale);
      if (params.model) fields.model = String(params.model);
    }
    if (params.seed != null && Number.isFinite(Number(params.seed))) fields.seed = String(params.seed);

    const override = applyRawOverride<Record<string, any>>({}, params.rawRequestOverride);
    for (const [key, value] of Object.entries(override)) {
      if (value != null && typeof value !== "object") fields[key] = String(value);
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (sources.length > 0) {
      if (!acceptsImage) {
        throw new Error(`Stability ${model} does not accept a source image. Use "ultra" or "sd3".`);
      }
      const { bytes, mimeType } = decodeImage(sources[0]);
      const ext = mimeType.split("/")[1] || "png";
      form.append("image", new Blob([bytes], { type: mimeType }), `source.${ext}`);
      const strength = params.strength != null && Number.isFinite(Number(params.strength))
        ? Number(params.strength)
        : 0.65;
      form.append("strength", String(strength));
      if (model === "sd3") form.append("mode", "image-to-image");
    }

    const res = await fetch(`${base}/v2beta/stable-image/generate/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: form,
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    if (data?.finish_reason === "CONTENT_FILTERED") {
      throw new Error("Stability filtered the prompt (CONTENT_FILTERED). Adjust the prompt and retry.");
    }
    if (typeof data?.image === "string" && data.image) {
      const format = params.outputFormat || "png";
      return { imageDataUrl: `data:image/${format};base64,${data.image}`, model, provider: this.name };
    }
    if (typeof data?.artifacts?.[0]?.base64 === "string") {
      return { imageDataUrl: `data:image/png;base64,${data.artifacts[0].base64}`, model, provider: this.name };
    }
    throw new Error("Stability returned no image data");
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://api.stability.ai/v1/user/account", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(_apiKey: string, _apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    return this.capabilities.staticModels || [];
  }
}
