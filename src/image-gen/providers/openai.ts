import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride, PROTECTED_RAW_OVERRIDE_KEYS } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/**
 * OpenAI Images API (`/images/generations`, `/images/edits`).
 *
 * Serves both the official API and OpenAI-compatible deployments (reverse
 * proxies, LiteLLM, etc.) — the connection's API URL replaces the default
 * base, so any host exposing the same surface works.
 *
 * Two model families share the endpoint with diverging parameter sets:
 * - GPT image models (gpt-image-1/-mini/-1.5/-2, chatgpt-image-*): always
 *   return base64, reject `response_format`, and accept `background`,
 *   `moderation`, `output_format`, and (on edits) `input_fidelity`.
 * - DALL·E 2/3 and unknown/compatible models: need `response_format:
 *   "b64_json"` to skip the 60-minute URL hop; dall-e-3 additionally takes
 *   `style`.
 * Family-specific params are gated on the model id so a cross-family value
 * never reaches the wrong API.
 *
 * Image-to-image rides on `/images/edits` (multipart) and is engaged by the
 * presence of resolved source images, mirroring the SD API provider.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "select",
        default: "auto",
        description: "Output image dimensions (model-dependent; GPT image models also accept Auto)",
        options: [
          { id: "auto", label: "Auto" },
          { id: "1024x1024", label: "1024x1024 (Square)" },
          { id: "1536x1024", label: "1536x1024 (Landscape, GPT image)" },
          { id: "1024x1536", label: "1024x1536 (Portrait, GPT image)" },
          { id: "1792x1024", label: "1792x1024 (Landscape, DALL-E 3)" },
          { id: "1024x1792", label: "1024x1792 (Portrait, DALL-E 3)" },
          { id: "512x512", label: "512x512 (DALL-E 2)" },
          { id: "256x256", label: "256x256 (DALL-E 2)" },
        ],
      },
      quality: {
        type: "select",
        default: "auto",
        description: "Image quality — Low/Medium/High for GPT image models, Standard/HD for DALL-E 3",
        options: [
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low (GPT image)" },
          { id: "medium", label: "Medium (GPT image)" },
          { id: "high", label: "High (GPT image)" },
          { id: "standard", label: "Standard (DALL-E 3)" },
          { id: "hd", label: "HD (DALL-E 3)" },
        ],
      },
      style: {
        type: "select",
        default: "vivid",
        description: "Rendering style (DALL-E 3 only)",
        options: [
          { id: "vivid", label: "Vivid" },
          { id: "natural", label: "Natural" },
        ],
      },
      background: {
        type: "select",
        default: "auto",
        description: "Background transparency (GPT image models only)",
        options: [
          { id: "auto", label: "Auto" },
          { id: "opaque", label: "Opaque" },
          { id: "transparent", label: "Transparent" },
        ],
        group: "advanced",
      },
      outputFormat: {
        type: "select",
        default: "png",
        description: "Returned image format (GPT image models only)",
        options: [
          { id: "png", label: "PNG" },
          { id: "jpeg", label: "JPEG" },
          { id: "webp", label: "WebP" },
        ],
        group: "advanced",
      },
      moderation: {
        type: "select",
        default: "low",
        description: "Content moderation strictness (GPT image models only) — Low is the least restrictive level the API offers and is used by default",
        options: [
          { id: "low", label: "Low" },
          { id: "auto", label: "Auto" },
        ],
        group: "advanced",
      },
      inputFidelity: {
        type: "select",
        default: "low",
        description: "How closely edits preserve the input image's style and features (GPT image models only)",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        group: "references",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    staticModels: [
      { id: "gpt-image-1.5", label: "GPT Image 1.5" },
      { id: "gpt-image-1", label: "GPT Image 1" },
      { id: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
      { id: "chatgpt-image-latest", label: "ChatGPT Image (Latest)" },
      { id: "dall-e-3", label: "DALL-E 3" },
      { id: "dall-e-2", label: "DALL-E 2" },
    ],
    defaultUrl: "https://api.openai.com/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "gpt-image-1";

    // Source images for img2img — resolved upstream (manual uploads +
    // character/persona avatars); fall back to raw referenceImages.
    const sources: Array<{ data: string; mimeType?: string }> =
      params.resolvedSourceImages || params.referenceImages || [];
    const usableSources = sources.filter((s) => !!s?.data);

    const res = usableSources.length > 0
      ? await this.requestEdit(apiKey, apiUrl, model, request, usableSources)
      : await this.requestGeneration(apiKey, apiUrl, model, request);

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const first = data?.data?.[0];
    let imageDataUrl: string | undefined;
    if (first?.b64_json) {
      const format = this.isGptImageModel(model) ? params.outputFormat || "png" : "png";
      imageDataUrl = `data:image/${format};base64,${first.b64_json}`;
    } else if (first?.url) {
      imageDataUrl = await this.toDataUrl(first.url, request.signal);
    }
    if (!imageDataUrl) throw new Error("OpenAI returned no image data");

    return { imageDataUrl, model, provider: this.name };
  }

  private async requestGeneration(
    apiKey: string,
    apiUrl: string,
    model: string,
    request: ImageGenRequest,
  ): Promise<Response> {
    const body = this.buildCommonBody(model, request, "generation");

    // Apply raw request override (power-user escape hatch — e.g.
    // output_compression, partial_images, or arbitrary gpt-image-2 sizes).
    const finalBody = applyRawOverride(body, request.parameters.rawRequestOverride);

    return fetch(`${this.baseUrl(apiUrl)}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
  }

  private async requestEdit(
    apiKey: string,
    apiUrl: string,
    model: string,
    request: ImageGenRequest,
    sources: Array<{ data: string; mimeType?: string }>,
  ): Promise<Response> {
    const params = request.parameters;
    const fields = this.buildCommonBody(model, request, "edit");
    if (this.isGptImageModel(model) && params.inputFidelity) {
      fields.input_fidelity = params.inputFidelity;
    }

    // Image file parts must not be forgeable through the override.
    const finalFields = applyRawOverride(fields, params.rawRequestOverride, [
      ...PROTECTED_RAW_OVERRIDE_KEYS,
      "image",
      "image[]",
      "mask",
    ]);

    const form = new FormData();
    for (const [key, value] of Object.entries(finalFields)) {
      if (value === null || value === undefined) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }

    // GPT image models accept multiple reference images via `image[]`;
    // a single image uses the plain `image` field (works for all models).
    const fieldName = sources.length > 1 ? "image[]" : "image";
    sources.forEach((src, i) => {
      const { bytes, mimeType } = this.decodeImage(src);
      const ext = mimeType.split("/")[1] || "png";
      form.append(fieldName, new Blob([bytes], { type: mimeType }), `source-${i}.${ext}`);
    });

    return fetch(`${this.baseUrl(apiUrl)}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: request.signal,
    });
  }

  /**
   * Shared request fields for both endpoints, gated by model family. "auto"
   * selections are omitted — they are the API defaults for models that accept
   * them and are rejected by models that don't.
   */
  private buildCommonBody(
    model: string,
    request: ImageGenRequest,
    operation: "generation" | "edit",
  ): Record<string, any> {
    const params = request.parameters;
    const body: Record<string, any> = { model, prompt: request.prompt, n: 1 };

    if (params.size && params.size !== "auto") body.size = params.size;
    if (params.quality && params.quality !== "auto") body.quality = params.quality;

    if (this.isGptImageModel(model)) {
      if (params.background && params.background !== "auto") body.background = params.background;
      // Default to the least restrictive moderation; an explicit "auto" opts
      // back into the API's stricter default filtering.
      const moderation = params.moderation || "low";
      if (moderation !== "auto") body.moderation = moderation;
      if (params.outputFormat && params.outputFormat !== "png") body.output_format = params.outputFormat;
    } else {
      // DALL·E and unknown compatible models return temporary URLs by default;
      // ask for base64 so the pipeline always gets durable image data.
      body.response_format = "b64_json";
      if (/^dall-e-3/i.test(model) && params.style && operation === "generation") {
        body.style = params.style;
      }
    }

    return body;
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
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
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const all: Array<{ id: string; label: string }> = (data?.data || [])
      .map((m: any) => ({ id: m.id, label: m.name || m.id }))
      .filter((m: { id: string }) => typeof m.id === "string" && m.id.length > 0);

    // `/models` mixes chat, embedding, and image models — keep the image ones.
    // Compatible proxies may use custom names, so when nothing matches, fall
    // back to the full list rather than hiding the proxy's models.
    const imageModels = all.filter((m) => /gpt-image|dall-e|chatgpt-image/i.test(m.id));
    const models = imageModels.length > 0 ? imageModels : all;
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }

  private isGptImageModel(model: string): boolean {
    return /^(gpt-image|chatgpt-image)/i.test(model);
  }

  /** Accepts raw base64 or a full data URL and returns bytes + MIME type. */
  private decodeImage(src: { data: string; mimeType?: string }): { bytes: Buffer<ArrayBuffer>; mimeType: string } {
    let base64 = src.data;
    let mimeType = src.mimeType || "image/png";
    const dataUrlMatch = base64.match(/^data:([^;,]+)?;base64,(.*)$/s);
    if (dataUrlMatch) {
      if (dataUrlMatch[1]) mimeType = dataUrlMatch[1];
      base64 = dataUrlMatch[2];
    }
    return { bytes: Buffer.from(base64, "base64"), mimeType };
  }

  /** Inline an http(s) image URL as a base64 data URL. */
  private async toDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    if (url.startsWith("data:")) return url;
    const res = await fetch(url, { signal });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image fetch", res);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  /**
   * Normalize the connection's API URL. Tolerates a pasted full endpoint
   * (".../images/generations") and trailing slashes so reverse proxies and
   * compatible providers can be pointed at directly.
   */
  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || "").trim().replace(/\/+$/, "");
    if (!url) return this.capabilities.defaultUrl;
    url = url.replace(/\/images\/(generations|edits)$/, "");
    return url;
  }
}
