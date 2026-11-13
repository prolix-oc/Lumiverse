import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError, parseProviderErrorBody, readBoundedText } from "../../utils/provider-errors";
import { trimBaseUrl } from "./shared";

/**
 * Hugging Face Inference Providers — `hf-inference` text-to-image route.
 *
 * The OpenAI-compatible client is not supported for image generation, so this
 * provider talks to the direct route
 * `POST {router}/hf-inference/models/{org}/{model}` with Bearer auth. The model
 * field carries `{org}/{model}`. The default response is raw image bytes; a
 * JSON error body is surfaced with its `error` message.
 *
 * A token needs the "Make calls to Inference Providers" permission.
 *
 * @see https://huggingface.co/docs/inference-providers/providers/hf-inference
 */
export class HuggingFaceImageProvider implements ImageProvider {
  readonly name = "huggingface";
  readonly displayName = "Hugging Face";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      negativePrompt: {
        type: "string",
        description: "Optional negative prompt (model-dependent)",
        group: "advanced",
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
      { id: "black-forest-labs/FLUX.1-schnell", label: "FLUX.1 schnell" },
      { id: "black-forest-labs/FLUX.1-dev", label: "FLUX.1 dev" },
      { id: "stabilityai/stable-diffusion-xl-base-1.0", label: "SDXL Base 1.0" },
      { id: "stabilityai/stable-diffusion-3.5-large", label: "Stable Diffusion 3.5 Large" },
    ],
    defaultUrl: "https://router.huggingface.co",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/(hf-inference|models)\/.*$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "black-forest-labs/FLUX.1-schnell";
    const base = this.baseUrl(apiUrl);

    const parameters: Record<string, any> = {};
    if (request.negativePrompt || params.negativePrompt) {
      parameters.negative_prompt = String(request.negativePrompt || params.negativePrompt);
    }
    if (params.numInferenceSteps != null && Number.isFinite(Number(params.numInferenceSteps))) {
      parameters.num_inference_steps = Number(params.numInferenceSteps);
    }
    if (params.guidanceScale != null && Number.isFinite(Number(params.guidanceScale))) {
      parameters.guidance_scale = Number(params.guidanceScale);
    }
    if (params.seed != null && Number.isFinite(Number(params.seed))) parameters.seed = Number(params.seed);

    const body: Record<string, any> = { inputs: request.prompt };
    if (Object.keys(parameters).length > 0) body.parameters = parameters;

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const res = await fetch(`${base}/hf-inference/models/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "image/png", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) {
      const raw = await readBoundedText(res);
      const parsed = parseProviderErrorBody(raw);
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "image generate",
        status: res.status,
        code: parsed.code || res.statusText || undefined,
        detail: parsed.detail || res.statusText || undefined,
        rawBody: raw,
      });
    }

    const contentType = res.headers.get("content-type") || "image/png";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      const b64 = data?.image || data?.[0]?.b64_json;
      if (typeof b64 === "string" && b64) {
        return { imageDataUrl: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`, model, provider: this.name };
      }
      throw new Error("Hugging Face returned no image data");
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    return { imageDataUrl: `data:${contentType.split(";")[0]};base64,${bytes.toString("base64")}`, model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://huggingface.co/api/whoami-v2", {
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
