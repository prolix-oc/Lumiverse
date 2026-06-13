import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/**
 * OpenRouter image generation.
 *
 * Unlike most image providers, OpenRouter has no dedicated images endpoint —
 * image generation rides on the OpenAI-style `/chat/completions` endpoint with
 * a `modalities` hint. Generated images come back as base64 data URLs on
 * `choices[0].message.images[].image_url.url`.
 *
 * Image-to-image / reference editing is expressed by attaching the source
 * images as `image_url` content parts on the user message (text first, then
 * images), mirroring the multimodal input format. `image_config.strength`
 * controls how far the result drifts from the input for models that support it
 * (e.g. Recraft).
 *
 * @see https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 * @see https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
 */
export class OpenRouterImageProvider implements ImageProvider {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "1:1",
        description: "Output image aspect ratio (model-dependent)",
        options: [
          { id: "1:1", label: "1:1 (Square)" },
          { id: "2:3", label: "2:3" },
          { id: "3:2", label: "3:2" },
          { id: "3:4", label: "3:4" },
          { id: "4:3", label: "4:3" },
          { id: "4:5", label: "4:5" },
          { id: "5:4", label: "5:4" },
          { id: "9:16", label: "9:16 (Portrait)" },
          { id: "16:9", label: "16:9 (Landscape)" },
          { id: "21:9", label: "21:9 (Ultrawide)" },
        ],
      },
      imageSize: {
        type: "select",
        default: "1K",
        description: "Output resolution tier (model-dependent)",
        options: [
          { id: "0.5K", label: "0.5K" },
          { id: "1K", label: "1K" },
          { id: "2K", label: "2K" },
          { id: "4K", label: "4K" },
        ],
      },
      strength: {
        type: "number",
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Image-to-image strength — how much the result may differ from the reference (Recraft and similar). Only applied when reference images are present.",
        group: "references",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    staticModels: [
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 Pro" },
      { id: "openai/gpt-image-1", label: "GPT Image 1" },
    ],
    defaultUrl: "https://openrouter.ai/api/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;

    // Reference / source images for img2img and reference editing. Resolved
    // upstream into `resolvedSourceImages` (manual uploads + character/persona
    // avatars); fall back to raw `referenceImages` for manual-only flows.
    const sources: Array<{ data: string; mimeType?: string }> =
      params.resolvedSourceImages || params.referenceImages || [];

    // Text part first, then images (per OpenRouter parsing guidance).
    const content: any[] = [{ type: "text", text: request.prompt }];
    for (const src of sources) {
      if (!src?.data) continue;
      const url = src.data.startsWith("data:")
        ? src.data
        : `data:${src.mimeType || "image/png"};base64,${src.data}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const body: any = {
      model: request.model,
      messages: [{ role: "user", content }],
      // Superset modality — works for image+text models (Gemini, GPT Image) and
      // image-only models still return their image on message.images.
      modalities: ["image", "text"],
    };

    const imageConfig: Record<string, any> = {};
    if (params.aspectRatio) imageConfig.aspect_ratio = params.aspectRatio;
    if (params.imageSize) imageConfig.image_size = params.imageSize;
    // strength only meaningful for image-to-image — gate on having sources.
    if (sources.length > 0 && params.strength != null) imageConfig.strength = Number(params.strength);
    if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;

    // Apply raw request override (power-user escape hatch — e.g. force modalities
    // to ["image"] for strict image-only models, or pass provider routing).
    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const res = await fetch(`${this.baseUrl(apiUrl)}/chat/completions`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const images = data?.choices?.[0]?.message?.images || [];
    let url: string | undefined;
    for (const img of images) {
      url = img?.image_url?.url || img?.url || (typeof img === "string" ? img : undefined);
      if (url) break;
    }
    if (!url) throw new Error("OpenRouter returned no image data");

    return {
      imageDataUrl: await this.toDataUrl(url, request.signal),
      model: request.model,
      provider: this.name,
    };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      // OpenRouter's /key endpoint reports credit info and authenticates cheaply.
      const res = await fetch(`${this.baseUrl(apiUrl)}/key`, { headers: this.headers(apiKey) });
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) {
        await throwProviderResponseError(this.displayName, "authentication", res);
      }
      // Fall back to /models for deployments that don't expose /key.
      const models = await fetch(`${this.baseUrl(apiUrl)}/models`, { headers: this.headers(apiKey) });
      if (!models.ok) await throwProviderResponseError(this.displayName, "authentication", models);
      return models.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const url = `${this.baseUrl(apiUrl)}/models?output_modalities=image`;
    const data = await fetchProviderJson<any>(this.displayName, "model listing", url, {
      headers: this.headers(apiKey),
    });
    const models: Array<{ id: string; label: string }> = (data?.data || [])
      .map((m: any) => ({ id: m.id, label: m.name || m.id }))
      .filter((m: { id: string }) => typeof m.id === "string" && m.id.length > 0)
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }

  /**
   * Normalize a returned image reference into a base64 data URL. Most models
   * return a `data:` URL directly; some return an http(s) URL which we fetch and
   * inline so the rest of the pipeline always receives a data URL.
   */
  private async toDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    if (url.startsWith("data:")) return url;
    const res = await fetch(url, { signal });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image fetch", res);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://lumiverse.chat",
      "X-Title": "Lumiverse",
    };
  }

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/chat\/completions$/, "");
    return url;
  }
}
