import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";

export class PollinationsImageProvider implements ImageProvider {
  readonly name = "pollinations";
  readonly displayName = "Pollinations";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 256,
        max: 2048,
        default: 1024,
        description: "Image width in pixels",
      },
      height: {
        type: "integer",
        min: 256,
        max: 2048,
        default: 1024,
        description: "Image height in pixels",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducible images",
        group: "advanced",
      },
      enhance: {
        type: "boolean",
        default: false,
        description: "Enable prompt enhancement",
        group: "advanced",
      },
      quality: {
        type: "select",
        default: "auto",
        description: "Generation quality tier",
        group: "advanced",
        options: [
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      transparent: {
        type: "boolean",
        default: false,
        description: "Request transparent background when supported",
        group: "advanced",
      },
      negative_prompt: {
        type: "string",
        description: "Optional negative prompt",
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
      { id: "zimage", label: "zimage" },
      { id: "flux", label: "flux" },
      { id: "gptimage", label: "gptimage" },
      { id: "gptimage-large", label: "gptimage-large" },
      { id: "kontext", label: "kontext" },
      { id: "nanobanana", label: "nanobanana" },
      { id: "seedream", label: "seedream" },
      { id: "seedream5", label: "seedream5" },
      { id: "qwen-image", label: "qwen-image" },
      { id: "nova-canvas", label: "nova-canvas" },
    ],
    defaultUrl: "https://gen.pollinations.ai/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const base = this.baseUrl(apiUrl);
    const width = Number(request.parameters.width || 1024);
    const height = Number(request.parameters.height || 1024);

    const body: Record<string, any> = {
      prompt: request.prompt,
      model: request.model || "zimage",
      n: 1,
      size: `${width}x${height}`,
      response_format: "b64_json",
    };

    if (request.parameters.seed != null && Number.isFinite(Number(request.parameters.seed))) {
      body.seed = Number(request.parameters.seed);
    }
    if (request.parameters.enhance != null) body.enhance = !!request.parameters.enhance;
    if (request.parameters.quality) body.quality = String(request.parameters.quality);
    if (request.parameters.transparent != null) body.transparent = !!request.parameters.transparent;
    if (request.parameters.negative_prompt) body.negative_prompt = String(request.parameters.negative_prompt);

    const finalBody = applyRawOverride(body, request.parameters.rawRequestOverride);

    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(`Pollinations API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);
    }

    const data = (await res.json()) as any;
    const item = data?.data?.[0];
    const b64 = item?.b64_json;
    const imageUrl = item?.url;

    if (b64) {
      return {
        imageDataUrl: `data:image/png;base64,${b64}`,
        model: body.model,
        provider: this.name,
      };
    }

    if (imageUrl) {
      const imageRes = await fetch(imageUrl, { signal: request.signal });
      if (!imageRes.ok) {
        throw new Error(`Pollinations image fetch failed ${imageRes.status}`);
      }
      const contentType = imageRes.headers.get("content-type") || "image/png";
      const bytes = new Uint8Array(await imageRes.arrayBuffer());
      const base64 = Buffer.from(bytes).toString("base64");
      return {
        imageDataUrl: `data:${contentType};base64,${base64}`,
        model: body.model,
        provider: this.name,
      };
    }

    throw new Error("Pollinations returned no image data");
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    if (!apiKey) return false;
    try {
      const base = this.baseUrl(apiUrl).replace(/\/v1\/?$/, "");
      const res = await fetch(`${base}/account/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    try {
      const base = this.baseUrl(apiUrl).replace(/\/v1\/?$/, "");
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${base}/image/models`, { headers });
      if (!res.ok) return this.capabilities.staticModels || [];

      const data = (await res.json()) as any;
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data?.data)
            ? data.data
            : [];

      const models = list
        .map((m: any) => ({
          id: String(m?.id || m?.model || m?.name || "").trim(),
          label: String(m?.name || m?.label || m?.id || m?.model || "").trim(),
        }))
        .filter((m: { id: string; label: string }) => !!m.id)
        .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));

      return models.length > 0 ? models : this.capabilities.staticModels || [];
    } catch {
      return this.capabilities.staticModels || [];
    }
  }

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/images\/generations$/, "");
    url = url.replace(/\/image\/models$/, "");
    if (!url.endsWith("/v1")) {
      url = url.replace(/\/v1\/?$/, "");
      url += "/v1";
    }
    return url;
  }
}
