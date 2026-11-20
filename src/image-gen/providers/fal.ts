import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { pollUntil, sourceImages, toDataUrl, trimBaseUrl } from "./shared";
import { imageInputMechanism } from "../image-input";

/**
 * fal.ai queue API (`POST https://queue.fal.run/{owner}/{app}`).
 *
 * Auth uses `Authorization: Key <key>` (not Bearer). Submission returns
 * `status_url` / `response_url`; the status endpoint is polled until
 * `COMPLETED`, then the response URL yields the model-specific output. Output
 * images live under `images[]` for text-to-image models; the first image URL is
 * downloaded immediately.
 *
 * @see https://docs.fal.ai/model-apis/model-endpoints/queue
 */
export class FalImageProvider implements ImageProvider {
  readonly name = "fal";
  readonly displayName = "fal.ai";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      imageSize: {
        type: "select",
        default: "landscape_4_3",
        description: "Output size preset",
        options: [
          { id: "square_hd", label: "Square HD" },
          { id: "square", label: "Square" },
          { id: "portrait_4_3", label: "Portrait 4:3" },
          { id: "portrait_16_9", label: "Portrait 16:9" },
          { id: "landscape_4_3", label: "Landscape 4:3" },
          { id: "landscape_16_9", label: "Landscape 16:9" },
        ],
      },
      numInferenceSteps: {
        type: "integer",
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      guidanceScale: {
        type: "number",
        min: 1,
        max: 20,
        step: 0.5,
        description: "Classifier-free guidance scale",
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
    modelListStyle: "static",
    staticModels: [
      { id: "fal-ai/flux/schnell", label: "FLUX schnell" },
      { id: "fal-ai/flux/dev", label: "FLUX dev" },
      { id: "fal-ai/flux-pro/v1.1", label: "FLUX Pro 1.1" },
      { id: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX Pro 1.1 Ultra" },
      { id: "fal-ai/stable-diffusion-v35-large", label: "Stable Diffusion 3.5 Large" },
    ],
    defaultUrl: "https://queue.fal.run",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl);
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "fal-ai/flux/schnell";
    const base = this.baseUrl(apiUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Key ${apiKey}` };

    const body: Record<string, any> = { prompt: request.prompt };
    if (params.imageSize) body.image_size = String(params.imageSize);
    if (params.numInferenceSteps != null && Number.isFinite(Number(params.numInferenceSteps))) body.num_inference_steps = Number(params.numInferenceSteps);
    if (params.guidanceScale != null && Number.isFinite(Number(params.guidanceScale))) body.guidance_scale = Number(params.guidanceScale);
    if (params.seed != null && Number.isFinite(Number(params.seed))) body.seed = Number(params.seed);
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;

    const sources = sourceImages(params);
    if (sources.length > 0 && !imageInputMechanism(this.name, model)) {
      throw new Error(`fal.ai ${model} does not accept a source image. Choose an image-to-image endpoint.`);
    }
    if (sources.length > 0) body.image_url = sources[0].data.startsWith("data:") ? sources[0].data : `data:${sources[0].mimeType || "image/png"};base64,${sources[0].data}`;

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const submit = await fetch(`${base}/${model}`, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!submit.ok) await throwProviderResponseError(this.displayName, "image generate", submit);

    const job = await submit.json();
    const statusUrl: string | undefined = job?.status_url;
    const responseUrl: string | undefined = job?.response_url;
    if (!statusUrl || !responseUrl) throw new Error("fal.ai returned no status URL");

    const output = await pollUntil<Record<string, any>>({
      intervalMs: 1000,
      timeoutMs: 300_000,
      signal: request.signal,
      check: async () => {
        const res = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` }, signal: request.signal });
        if (!res.ok) await throwProviderResponseError(this.displayName, "image polling", res);
        const status = await res.json();
        const state = String(status?.status || "");
        if (state === "COMPLETED") {
          const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` }, signal: request.signal });
          if (!resultRes.ok) await throwProviderResponseError(this.displayName, "image result", resultRes);
          return { done: true, value: await resultRes.json() };
        }
        if (state === "FAILED" || state === "ERROR") {
          return { done: true, error: status?.error || "fal.ai job failed" };
        }
        return { done: false };
      },
    });

    const url = output?.images?.[0]?.url || output?.image?.url;
    if (!url) throw new Error("fal.ai returned no image data");
    return { imageDataUrl: await toDataUrl(url, request.signal), model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://rest.alpha.fal.ai/tokens/", {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_apps: ["fal-ai/flux/schnell"] }),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return true;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(_apiKey: string, _apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    return this.capabilities.staticModels || [];
  }
}
