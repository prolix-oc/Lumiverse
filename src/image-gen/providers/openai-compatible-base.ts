import type { ImageProvider } from "../provider";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { toDataUrl, decodeImage } from "./shared";

export interface OpenAiCompatibleOptions {
  /** Extra request fields (e.g. `steps`, `n`) merged in before the raw override. */
  buildExtraBody?: (request: ImageGenRequest) => Record<string, any>;
  /** Model-id filter for the live `/models` list. Defaults to keeping everything. */
  isImageModel?: (id: string) => boolean;
  /** Header set for both generation and auth checks. Defaults to Bearer auth. */
  headers?: (apiKey: string) => Record<string, string>;
  /** Route to `POST {base}/images/edits` (multipart) when source images are present. */
  supportsEdits?: boolean;
  /** Sent as `response_format`. OpenAI uses `b64_json`; Together uses `base64`. */
  responseFormat?: "b64_json" | "base64";
  /** Set false for providers that reject `size` and take `width`/`height` instead. */
  supportsSize?: boolean;
  /** Forward the request's negative prompt as `negative_prompt`. */
  supportsNegativePrompt?: boolean;
}

/**
 * Base for providers that expose the OpenAI Images surface
 * (`POST {base}/images/generations`) and return either `data[].b64_json` or
 * `data[].url`. Together AI, xAI, Venice (compat), Recraft, DeepInfra and the
 * generic custom connection all share this shape.
 *
 * URL results are downloaded immediately so the pipeline always receives
 * durable image bytes rather than a short-lived link.
 */
export abstract class OpenAiCompatibleImageProvider implements ImageProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: ImageProvider["capabilities"];

  protected readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions = {}) {
    this.options = options;
  }

  protected baseUrl(apiUrl: string): string {
    let url = (apiUrl || "").trim().replace(/\/+$/, "");
    if (!url) return this.capabilities.defaultUrl;
    url = url.replace(/\/images\/(generations|edits)$/, "");
    return url;
  }

  protected headers(apiKey: string): Record<string, string> {
    if (this.options.headers) return this.options.headers(apiKey);
    return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  /** Extra request fields merged in before the raw override. Subclasses may override. */
  protected buildExtraBody(request: ImageGenRequest): Record<string, any> {
    return this.options.buildExtraBody?.(request) ?? {};
  }

  /** Model-id filter for the live `/models` list. Subclasses may override. */
  protected isImageModel(id: string): boolean {
    return this.options.isImageModel?.(id) ?? true;
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || this.capabilities.staticModels?.[0]?.id || "";

    const body: Record<string, any> = {
      model,
      prompt: request.prompt,
      n: 1,
      response_format: this.options.responseFormat ?? "b64_json",
    };
    if (this.options.supportsSize !== false && params.size) body.size = params.size;
    if (this.options.supportsNegativePrompt && request.negativePrompt) body.negative_prompt = request.negativePrompt;
    Object.assign(body, this.buildExtraBody(request));

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const sources = (params.resolvedSourceImages || params.referenceImages || []).filter((s: any) => !!s?.data);
    const res =
      this.options.supportsEdits && sources.length > 0
        ? await this.requestEdit(apiKey, apiUrl, finalBody, sources, request.signal)
        : await this.requestGeneration(apiKey, apiUrl, finalBody, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const first = data?.data?.[0];
    let imageDataUrl: string | undefined;
    if (first?.b64_json) {
      imageDataUrl = `data:image/png;base64,${first.b64_json}`;
    } else if (first?.url) {
      imageDataUrl = await toDataUrl(first.url, request.signal);
    }
    if (!imageDataUrl) throw new Error(`${this.displayName} returned no image data`);

    return { imageDataUrl, model, provider: this.name };
  }

  private requestGeneration(
    apiKey: string,
    apiUrl: string,
    body: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(`${this.baseUrl(apiUrl)}/images/generations`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * Multipart `/images/edits` request. Image file parts are appended after the
   * JSON fields; the raw override is applied before this point, so it cannot
   * forge the image parts (the base body has no `image` key).
   */
  private requestEdit(
    apiKey: string,
    apiUrl: string,
    body: Record<string, any>,
    sources: Array<{ data: string; mimeType?: string }>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined || key === "image" || key === "image[]") continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    sources.forEach((src, i) => {
      const { bytes, mimeType } = decodeImage(src);
      const ext = mimeType.split("/")[1] || "png";
      form.append("image", new Blob([bytes], { type: mimeType }), `source-${i}.${ext}`);
    });

    const { "Content-Type": _ct, ...headers } = this.headers(apiKey);
    return fetch(`${this.baseUrl(apiUrl)}/images/edits`, {
      method: "POST",
      headers,
      body: form,
      signal,
    });
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, { headers: this.headers(apiKey) });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models`, {
      headers: this.headers(apiKey),
    });
    const all: Array<{ id: string; label: string }> = (data?.data || data?.models || [])
      .map((m: any) => ({ id: String(m?.id || m?.model || m?.name || "").trim(), label: String(m?.name || m?.label || m?.id || m?.model || "").trim() }))
      .filter((m: { id: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));

    const models = all.filter((m) => this.isImageModel(m.id));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }
}
