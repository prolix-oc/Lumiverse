import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { toDataUrl, trimBaseUrl } from "./shared";

/**
 * Civitai orchestration — chat-completions image path.
 *
 * A thin OpenRouter-style facade over `POST /v1/chat/completions` with
 * `modalities: ["image", "text"]`. Generated images come back as base64 data
 * URIs on `choices[0].message.images[].image_url.url`. Models include hosted
 * third-party image models (`google/gemini-2.5-flash-image`,
 * `black-forest-labs/flux.2-pro`, …) and Civitai AIR URNs.
 *
 * No LoRAs or samplers on this path — use the native workflow provider for
 * those.
 *
 * @see https://developer.civitai.com/orchestration/recipes/chat-completion
 */
export class CivitaiChatImageProvider implements ImageProvider {
  readonly name = "civitai_chat";
  readonly displayName = "Civitai (Chat)";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "1:1",
        description: "Output image aspect ratio",
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
        description: "Output resolution tier",
        options: [
          { id: "0.5K", label: "0.5K" },
          { id: "1K", label: "1K" },
          { id: "2K", label: "2K" },
          { id: "4K", label: "4K" },
        ],
      },
      tier: {
        type: "select",
        default: "",
        description: "Queue tier (free runs behind paid work and can expire)",
        options: [
          { id: "", label: "Default" },
          { id: "free", label: "Free" },
        ],
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the request body",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      { id: "openai/gpt-image-1", label: "GPT Image 1" },
      { id: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro" },
      { id: "black-forest-labs/flux.2-dev", label: "FLUX.2 Dev" },
    ],
    defaultUrl: "https://orchestration.civitai.com",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/v1\/.*$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "google/gemini-2.5-flash-image";
    const base = this.baseUrl(apiUrl);

    const body: Record<string, any> = {
      model,
      messages: [{ role: "user", content: request.prompt }],
      modalities: ["image", "text"],
    };

    const imageConfig: Record<string, any> = {};
    if (params.aspectRatio) imageConfig.aspect_ratio = params.aspectRatio;
    if (params.imageSize) imageConfig.image_size = params.imageSize;
    if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (params.tier === "free") headers["X-Civitai-Tier"] = "free";

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
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
    if (!url) throw new Error("Civitai returned no image data");

    return { imageDataUrl: await toDataUrl(url, request.signal), model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://orchestration.civitai.com/v2/consumer/free-tier", {
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
