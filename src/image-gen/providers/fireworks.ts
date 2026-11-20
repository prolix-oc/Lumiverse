import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { trimBaseUrl } from "./shared";

/**
 * Fireworks AI image generation.
 *
 * The workflow endpoint returns either raw bytes (`Accept: image/jpeg`) or a
 * JSON body with base64 entries under `base64[]`. Lumiverse requests JSON so
 * `finishReason` / `seed` come back alongside the image; a `CONTENT_FILTERED`
 * finish surfaces as an error rather than a silent empty result.
 *
 * Fireworks deprecated image generation (announced 2026-06-10) and retired the
 * FLUX serverless models, so only the SDXL-class models below still resolve on
 * the workflow route. Prefer another provider for new setups.
 *
 * @see https://docs.fireworks.ai/api-reference/generate-a-new-image-from-a-text-prompt
 */
export class FireworksImageProvider implements ImageProvider {
  readonly name = "fireworks";
  readonly displayName = "Fireworks AI";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "select",
        default: "1:1",
        description: "Output aspect ratio",
        options: [
          { id: "1:1", label: "1:1 (Square)" },
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "4:3", label: "4:3" },
          { id: "3:4", label: "3:4" },
          { id: "3:2", label: "3:2" },
          { id: "2:3", label: "2:3" },
        ],
      },
      guidanceScale: {
        type: "number",
        default: 3.5,
        min: 1,
        max: 20,
        step: 0.5,
        description: "Classifier-free guidance scale",
        group: "advanced",
      },
      numInferenceSteps: {
        type: "integer",
        default: 4,
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      seed: {
        type: "integer",
        default: 0,
        description: "Random seed (0 = random)",
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
      { id: "stable-diffusion-xl-1024-v1-0", label: "Stable Diffusion XL 1.0" },
      { id: "playground-v2-1024px-aesthetic", label: "Playground v2" },
    ],
    defaultUrl: "https://api.fireworks.ai/inference/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "stable-diffusion-xl-1024-v1-0";
    const base = trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/(workflows|image_generation)\/.*$/, "");

    const body: Record<string, any> = { prompt: request.prompt };
    if (params.aspectRatio) body.aspect_ratio = String(params.aspectRatio);
    if (params.guidanceScale != null && Number.isFinite(Number(params.guidanceScale))) body.guidance_scale = Number(params.guidanceScale);
    if (params.numInferenceSteps != null && Number.isFinite(Number(params.numInferenceSteps))) body.num_inference_steps = Number(params.numInferenceSteps);
    if (params.seed != null && Number.isFinite(Number(params.seed))) body.seed = Number(params.seed);

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const res = await fetch(`${base}/workflows/accounts/fireworks/models/${model}/text_to_image`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    if (data?.finishReason === "CONTENT_FILTERED") {
      throw new Error("Fireworks filtered the prompt (CONTENT_FILTERED). Adjust the prompt and retry.");
    }
    const b64: string | undefined = data?.base64?.[0];
    if (!b64) throw new Error("Fireworks returned no image data");

    const dataUrl = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
    return { imageDataUrl: dataUrl, model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://api.fireworks.ai/inference/v1/models", {
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
    try {
      const data = await fetchProviderJson<any>(this.displayName, "model listing", "https://api.fireworks.ai/inference/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const models: Array<{ id: string; label: string }> = (data?.data || [])
        .map((m: any) => String(m?.id || "").trim())
        .filter((id: string) => /flux|stable-diffusion|sdxl|playground|ssd|image/i.test(id))
        .map((id: string) => ({ id, label: id }));
      models.sort((a, b) => a.id.localeCompare(b.id));
      return models.length > 0 ? models : this.capabilities.staticModels || [];
    } catch {
      return this.capabilities.staticModels || [];
    }
  }
}
