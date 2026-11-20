import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/**
 * Venice AI native image generation (`POST /api/v1/image/generate`).
 *
 * Venice's native surface is richer than its OpenAI-compatible one: it accepts
 * `negative_prompt`, explicit `width`/`height` or an `aspect_ratio` plus
 * `resolution` tier, a `style_preset` (valid names come from
 * `GET /image/styles`), and `variants`. Sizing fields are model-specific —
 * check the Models API for what each model accepts.
 *
 * The response carries base64 strings in `images[]` (no data-URL prefix).
 *
 * @see https://docs.venice.ai/guides/media/image-generation
 */
export class VeniceImageProvider implements ImageProvider {
  readonly name = "venice";
  readonly displayName = "Venice AI";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 256,
        max: 2048,
        step: 16,
        description: "Image width in pixels (model-dependent)",
      },
      height: {
        type: "integer",
        min: 256,
        max: 2048,
        step: 16,
        description: "Image height in pixels (model-dependent)",
      },
      aspectRatio: {
        type: "select",
        default: "",
        description: "Use an aspect ratio instead of explicit width/height (model-dependent)",
        options: [
          { id: "", label: "Explicit width/height" },
          { id: "1:1", label: "1:1 (Square)" },
          { id: "2:3", label: "2:3" },
          { id: "3:2", label: "3:2" },
          { id: "3:4", label: "3:4" },
          { id: "4:3", label: "4:3" },
          { id: "9:16", label: "9:16 (Portrait)" },
          { id: "16:9", label: "16:9 (Landscape)" },
        ],
      },
      resolution: {
        type: "select",
        default: "1K",
        description: "Resolution tier (only applies when an aspect ratio is set, on tiered models)",
        options: [
          { id: "1K", label: "1K" },
          { id: "2K", label: "2K" },
          { id: "4K", label: "4K" },
        ],
        group: "advanced",
      },
      stylePreset: {
        type: "string",
        description: "Venice style preset name (see GET /image/styles for valid values)",
        group: "advanced",
      },
      format: {
        type: "select",
        default: "webp",
        description: "Returned image format",
        options: [
          { id: "webp", label: "WebP" },
          { id: "png", label: "PNG" },
          { id: "jpeg", label: "JPEG" },
        ],
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
      { id: "venice-sd35", label: "Venice SD 3.5" },
      { id: "flux-2-pro", label: "FLUX.2 Pro" },
    ],
    defaultUrl: "https://api.venice.ai/api/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "venice-sd35";

    const body: Record<string, any> = { model, prompt: request.prompt };
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (params.aspectRatio) {
      body.aspect_ratio = params.aspectRatio;
      if (params.resolution) body.resolution = params.resolution;
    } else {
      if (params.width != null) body.width = Number(params.width);
      if (params.height != null) body.height = Number(params.height);
    }
    if (params.stylePreset) body.style_preset = String(params.stylePreset);
    if (params.format) body.format = String(params.format);
    if (params.seed != null && Number.isFinite(Number(params.seed))) body.seed = Number(params.seed);

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const res = await fetch(`${this.baseUrl(apiUrl)}/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const image = data?.images?.[0];
    if (typeof image !== "string" || !image) throw new Error("Venice returned no image data");

    // Venice returns bare base64 (occasionally with a data-URL prefix).
    const dataUrl = image.startsWith("data:") ? image : `data:image/${params.format || "webp"};base64,${image}`;
    return { imageDataUrl: dataUrl, model, provider: this.name };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      // `/image/styles` is public (200 with any key), so it cannot authenticate.
      // `/api_keys/rate_limits` is authenticated and is callable by inference
      // keys (admin-only endpoints like `/billing/balance` are not).
      const res = await fetch(`${this.baseUrl(apiUrl)}/api_keys/rate_limits`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models?type=image`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const models: Array<{ id: string; label: string }> = (data?.data || [])
      .map((m: any) => ({ id: String(m?.id || "").trim(), label: String(m?.name || m?.id || "").trim() }))
      .filter((m: { id: string }) => !!m.id);
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).trim().replace(/\/+$/, "");
    url = url.replace(/\/image\/generate$/, "");
    return url;
  }
}
