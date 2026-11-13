import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { asDataUrl, sourceImages, toDataUrl, trimBaseUrl } from "./shared";

/**
 * xAI (Grok Imagine) image generation (`/v1/images/generations`).
 *
 * The request shape is OpenAI-like but its own: the output size is
 * `aspect_ratio` (plus an optional `resolution` tier of `1k` / `1.5k` / `2k`),
 * not `size`. `quality` (`low` / `medium` / `high`) is accepted only by
 * `grok-imagine-image-2.0` and bills at the tier served. Editing uses a
 * separate `POST /v1/images/edits` endpoint that takes **JSON** (not
 * multipart — xAI's docs explicitly say the OpenAI SDK's `images.edit()`
 * multipart call does not work), with the source image in `image: { url }` as
 * a public URL or a base64 data URL; up to five images go in `images[]`.
 *
 * @see https://docs.x.ai/developers/rest-api-reference/inference/images
 */
export class XaiImageProvider implements ImageProvider {
  readonly name = "xai";
  readonly displayName = "xAI (Grok Imagine)";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "auto",
        description: "Output aspect ratio",
        options: [
          { id: "auto", label: "Auto" },
          { id: "1:1", label: "1:1 (Square)" },
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "4:3", label: "4:3" },
          { id: "3:4", label: "3:4" },
          { id: "3:2", label: "3:2" },
          { id: "2:3", label: "2:3" },
          { id: "2:1", label: "2:1" },
          { id: "1:2", label: "1:2" },
          { id: "21:9", label: "21:9" },
          { id: "9:19.5", label: "9:19.5" },
          { id: "19.5:9", label: "19.5:9" },
          { id: "9:20", label: "9:20" },
          { id: "20:9", label: "20:9" },
          { id: "5:2", label: "5:2" },
        ],
      },
      resolution: {
        type: "select",
        default: "",
        description: "Output resolution tier",
        options: [
          { id: "", label: "Provider default (1k)" },
          { id: "1k", label: "1K" },
          { id: "1.5k", label: "1.5K" },
          { id: "2k", label: "2K" },
        ],
        group: "advanced",
      },
      quality: {
        type: "select",
        default: "",
        description: "Generation quality (grok-imagine-image-2.0 only; billed at the served tier)",
        options: [
          { id: "", label: "Auto (provider default)" },
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
        group: "advanced",
      },
      numImages: {
        type: "integer",
        min: 1,
        max: 10,
        default: 1,
        description: "Number of images to generate",
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
      { id: "grok-imagine-image-2.0", label: "Grok Imagine 2.0" },
      { id: "grok-imagine-image", label: "Grok Imagine" },
    ],
    defaultUrl: "https://api.x.ai/v1",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/images\/(generations|edits)$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || this.capabilities.staticModels?.[0]?.id || "grok-imagine-image-2.0";
    const base = this.baseUrl(apiUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    const sources = sourceImages(params);
    const editing = sources.length > 0;

    const body: Record<string, any> = {
      model,
      prompt: request.prompt,
      n: Number.isFinite(Number(params.numImages)) ? Number(params.numImages) : 1,
      response_format: "b64_json",
    };
    if (params.aspectRatio) body.aspect_ratio = String(params.aspectRatio);
    if (params.resolution) body.resolution = String(params.resolution);
    if (params.quality) body.quality = String(params.quality);

    if (editing) {
      // `image` and `images` are mutually exclusive; a single reference uses
      // `image`, several use `images[]` (referred to as <IMAGE_0> in the prompt).
      // Each entry is an ImageUrl object taking a public URL or data URL.
      const refs = sources.map((src) => ({ url: asDataUrl(src) }));
      if (refs.length === 1) body.image = refs[0];
      else body.images = refs;
    }

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const res = await fetch(`${base}/images/${editing ? "edits" : "generations"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const first = data?.data?.[0];
    let imageDataUrl: string | undefined;
    if (first?.b64_json) imageDataUrl = `data:image/png;base64,${first.b64_json}`;
    else if (first?.url) imageDataUrl = await toDataUrl(first.url, request.signal);
    if (!imageDataUrl) throw new Error("xAI returned no image data");

    return { imageDataUrl, model, provider: this.name };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return this.capabilities.staticModels || [];
      const data = await res.json();
      const models: Array<{ id: string; label: string }> = (data?.data || data?.models || [])
        .filter((m: any) => !!m?.image_price || /imagine/i.test(String(m?.id || "")))
        .map((m: any) => String(m?.id || "").trim())
        .filter((id: string) => !!id)
        .map((id: string) => ({ id, label: id }));
      models.sort((a, b) => a.id.localeCompare(b.id));
      return models.length > 0 ? models : this.capabilities.staticModels || [];
    } catch {
      return this.capabilities.staticModels || [];
    }
  }
}
