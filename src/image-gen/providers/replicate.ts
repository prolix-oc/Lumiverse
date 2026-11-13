import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { pollUntil, toDataUrl, trimBaseUrl } from "./shared";

/**
 * Replicate predictions (`POST /v1/predictions`).
 *
 * `Prefer: wait` holds the request open briefly; if the prediction is still
 * running, its `urls.get` endpoint is polled until it reaches a terminal state.
 * Each model has its own input schema, so the prompt is sent as `input.prompt`
 * and any other field is reachable through the raw-request override (merged
 * into `input`).
 *
 * @see https://replicate.com/docs/topics/predictions/create-a-prediction
 */
export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate";
  readonly displayName = "Replicate";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      aspectRatio: {
        type: "string",
        description: "Optional aspect ratio (model-specific, e.g. 16:9). Leave blank to use the model default.",
      },
      numOutputs: {
        type: "integer",
        min: 1,
        max: 4,
        default: 1,
        description: "Number of images to generate",
        group: "advanced",
      },
      outputFormat: {
        type: "select",
        default: "png",
        description: "Returned image format",
        options: [
          { id: "png", label: "PNG" },
          { id: "jpg", label: "JPEG" },
          { id: "webp", label: "WebP" },
        ],
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the model input object",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "black-forest-labs/flux-schnell", label: "FLUX schnell" },
      { id: "black-forest-labs/flux-dev", label: "FLUX dev" },
      { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 Pro" },
      { id: "stability-ai/stable-diffusion-3.5-large", label: "Stable Diffusion 3.5 Large" },
    ],
    defaultUrl: "https://api.replicate.com/v1",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/predictions$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "black-forest-labs/flux-schnell";
    const base = this.baseUrl(apiUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    const input: Record<string, any> = { prompt: request.prompt };
    if (params.aspectRatio) input.aspect_ratio = String(params.aspectRatio);
    if (params.numOutputs != null && Number.isFinite(Number(params.numOutputs))) input.num_outputs = Number(params.numOutputs);
    if (params.outputFormat) input.output_format = String(params.outputFormat);
    if (params.seed != null && Number.isFinite(Number(params.seed))) input.seed = Number(params.seed);

    const merged = applyRawOverride<Record<string, any>>({ ...input }, params.rawRequestOverride);

    // Official models use the /models/{owner}/{name}/predictions path; community
    // models take a version hash in the body. A version hash can be supplied as
    // "owner/name:hash" in the model field.
    const versioned = /^[^/]+\/[^:]+:[0-9a-f]{8,}$/i.test(model);
    const endpoint = versioned ? `${base}/predictions` : `${base}/models/${model}/predictions`;
    const payload = versioned ? { version: model, input: merged } : { input: merged };

    const submit = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, Prefer: "wait=60" },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    if (!submit.ok) await throwProviderResponseError(this.displayName, "image generate", submit);

    let prediction = await submit.json();
    if (prediction?.status && !isTerminal(prediction.status)) {
      const getUrl: string | undefined = prediction?.urls?.get;
      if (!getUrl) throw new Error("Replicate returned no polling URL");
      prediction = await pollUntil<Record<string, any>>({
        intervalMs: 1000,
        timeoutMs: 300_000,
        signal: request.signal,
        check: async () => {
          const res = await fetch(getUrl, { headers, signal: request.signal });
          if (!res.ok) await throwProviderResponseError(this.displayName, "image polling", res);
          const current = await res.json();
          if (isTerminal(current?.status)) {
            if (current.status === "succeeded") return { done: true, value: current };
            return { done: true, error: current?.error || `Replicate prediction ${current?.status}` };
          }
          return { done: false };
        },
      });
    } else if (prediction?.status && prediction.status !== "succeeded") {
      throw new Error(prediction?.error || `Replicate prediction ${prediction.status}`);
    }

    const url = extractUrl(prediction?.output);
    if (!url) throw new Error("Replicate returned no image data");
    return { imageDataUrl: await toDataUrl(url, request.signal), model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://api.replicate.com/v1/account", {
        headers: { Authorization: `Bearer ${apiKey}` },
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

function isTerminal(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function extractUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.find((v) => typeof v === "string") as string | undefined;
  if (output && typeof output === "object") {
    const candidate = (output as Record<string, unknown>).url ?? (output as Record<string, unknown>)[0];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}
