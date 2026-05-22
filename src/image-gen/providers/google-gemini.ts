import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

export class GoogleGeminiImageProvider implements ImageProvider {
  readonly name = "google_gemini";
  readonly displayName = "Google Gemini";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "16:9",
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
        description: "Output image resolution tier",
        options: [
          { id: "1K", label: "1K" },
          { id: "2K", label: "2K" },
          { id: "4K", label: "4K" },
        ],
      },
    },
    apiKeyRequired: true,
    modelListStyle: "google",
    staticModels: [
      { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
      { id: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image Preview" },
    ],
    defaultUrl: "https://generativelanguage.googleapis.com/v1beta",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const base = this.baseUrl(apiUrl);
    const endpoint = `${base}/models/${request.model}:generateContent`;

    const body: any = {
      contents: [{ parts: [{ text: request.prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 1,
        topP: 0.95,
      },
    };

    const aspectRatio = request.parameters.aspectRatio;
    if (aspectRatio) {
      body.generationConfig.imageGenerationConfig = { aspectRatio };
    }

    // Apply raw request override (power-user escape hatch)
    const finalBody = applyRawOverride(body, request.parameters.rawRequestOverride);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p: any) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new Error("Gemini returned no image data");

    return {
      imageDataUrl: `data:${inline.mimeType || "image/png"};base64,${inline.data}`,
      model: request.model,
      provider: this.name,
    };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models?key=${apiKey}`);
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models?key=${apiKey}`);
    const models = (data.models || [])
      .map((m: any) => m.name?.replace("models/", "") || m.name)
      .filter((n: string) => n && n.includes("image"))
      .sort();
    if (models.length === 0) return this.capabilities.staticModels || [];
    return models.map((id: string) => ({ id, label: id }));
  }

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/models(\/.*)?$/, "");
    url = url.replace(/\/v1beta$/, "");
    if (!url.includes("/v1beta")) url += "/v1beta";
    return url;
  }
}
