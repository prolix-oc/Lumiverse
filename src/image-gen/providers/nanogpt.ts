import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { applyRawOverride } from "../types";

export class NanoGPTImageProvider implements ImageProvider {
  readonly name = "nanogpt";
  readonly displayName = "Nano-GPT";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "select",
        default: "1024x1024",
        description: "Output image dimensions",
        options: [
          { id: "256x256", label: "256x256" },
          { id: "512x512", label: "512x512" },
          { id: "1024x1024", label: "1024x1024" },
        ],
      },
      strength: {
        type: "number",
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Image guidance strength (for reference images)",
        group: "references",
      },
      guidanceScale: {
        type: "number",
        default: 7.5,
        min: 1,
        max: 20,
        step: 0.5,
        description: "Classifier-free guidance scale",
        group: "advanced",
      },
      numInferenceSteps: {
        type: "integer",
        default: 30,
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    staticModels: [
      { id: "hidream", label: "HiDream" },
      { id: "hidream_fast", label: "HiDream Fast" },
      { id: "hidream_dev", label: "HiDream Dev" },
      { id: "hidream_full", label: "HiDream Full" },
      { id: "flux-pro", label: "Flux Pro" },
      { id: "flux_pro_ultra", label: "Flux Pro Ultra" },
      { id: "flux-kontext", label: "Flux Kontext" },
      { id: "flux_schnell", label: "Flux Schnell" },
      { id: "dall-e-3", label: "DALL-E 3" },
      { id: "gpt_image_1", label: "GPT Image 1" },
      { id: "imagen4_preview", label: "Imagen 4 Preview" },
      { id: "midjourney", label: "Midjourney" },
      { id: "recraft", label: "Recraft" },
      { id: "sdxl", label: "SDXL" },
      { id: "sd35_large", label: "SD 3.5 Large" },
      { id: "reve-v1", label: "Reve v1" },
    ],
    defaultUrl: "https://nano-gpt.com/v1",
  };

  async generate(apiKey: string, _apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const requestBody: any = {
      model: request.model || "hidream",
      prompt: request.prompt,
      n: 1,
      size: params.size || "1024x1024",
      response_format: "b64_json",
    };

    const refs = params.referenceImages;
    if (Array.isArray(refs) && refs.length > 0) {
      requestBody.imageDataUrls = refs
        .filter((r: any) => !!r.data)
        .map((r: any) => `data:${r.mimeType || "image/png"};base64,${r.data}`);
      if (params.strength != null) requestBody.strength = params.strength;
      if (params.guidanceScale != null) requestBody.guidance_scale = params.guidanceScale;
      if (params.numInferenceSteps != null) requestBody.num_inference_steps = params.numInferenceSteps;
      if (params.seed != null) requestBody.seed = params.seed;
    }

    // Apply raw request override (power-user escape hatch)
    const finalBody = applyRawOverride(requestBody, params.rawRequestOverride);

    const res = await fetch("https://nano-gpt.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(`Nano-GPT API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);
    }

    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error("Nano-GPT returned no image data");

    return {
      imageDataUrl: `data:image/png;base64,${b64}`,
      model: request.model,
      provider: this.name,
    };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://nano-gpt.com/api/v1/image-models", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, _apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const data = await fetchProviderJson<any>(this.displayName, "model listing", "https://nano-gpt.com/api/v1/image-models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const modelList = Array.isArray(data) ? data : data.data || data.models || [];
    const models = modelList.map((m: any) => ({
      id: m.id || m.model || String(m),
      label: m.name || m.label || m.id || m.model || String(m),
    }));
    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }
}
