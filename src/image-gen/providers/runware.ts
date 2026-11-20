import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { asDataUrl, sourceImages, toDataUrl, trimBaseUrl } from "./shared";

/**
 * Runware image inference (`POST https://api.runware.ai/v1`).
 *
 * The REST API takes a JSON **array** of task objects; `taskType:
 * "imageInference"` with `positivePrompt`, `model`, `width`/`height`, and
 * `numberResults`. Results arrive in a parallel `data[]` array keyed by
 * `taskUUID` and carry `imageURL`. Model ids may reference Civitai checkpoints
 * directly (e.g. `civitai:112902@126688`).
 *
 * Image input goes in the task's `inputs` object: `seedImage` starts an
 * image-to-image generation (with `strength`) and `maskImage` restricts the
 * edited region. A model declares which inputs it accepts, and unknown inputs
 * are rejected, so a model that has no image-to-image mode fails loudly.
 *
 * @see https://runware.ai/docs/models-api/introduction
 * @see https://runware.ai/docs/models-api/model-schemas
 */
export class RunwareImageProvider implements ImageProvider {
  readonly name = "runware";
  readonly displayName = "Runware";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 128,
        max: 2048,
        step: 64,
        default: 1024,
        description: "Image width in pixels",
      },
      height: {
        type: "integer",
        min: 128,
        max: 2048,
        step: 64,
        default: 1024,
        description: "Image height in pixels",
      },
      numberResults: {
        type: "integer",
        min: 1,
        max: 4,
        default: 1,
        description: "Number of images to generate",
        group: "advanced",
      },
      steps: {
        type: "integer",
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      CFGScale: {
        type: "number",
        min: 1,
        max: 20,
        step: 0.5,
        description: "Classifier-free guidance scale",
        group: "advanced",
      },
      strength: {
        type: "number",
        min: 0,
        max: 1,
        step: 0.05,
        description: "Denoising strength for the seed image (image-to-image)",
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the task object",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "runware:100@1", label: "FLUX.1 Schnell" },
      { id: "runware:101@1", label: "FLUX.1 Dev" },
      { id: "civitai:112902@126688", label: "Civitai: DreamShaper XL" },
    ],
    defaultUrl: "https://api.runware.ai/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "runware:100@1";
    const base = trimBaseUrl(apiUrl || this.capabilities.defaultUrl);

    const taskUUID = crypto.randomUUID();
    const task: Record<string, any> = {
      taskType: "imageInference",
      taskUUID,
      positivePrompt: request.prompt,
      model,
      width: params.width != null ? Number(params.width) : 1024,
      height: params.height != null ? Number(params.height) : 1024,
    };
    if (request.negativePrompt) task.negativePrompt = request.negativePrompt;
    if (params.numberResults != null && Number.isFinite(Number(params.numberResults))) task.numberResults = Number(params.numberResults);
    if (params.steps != null && Number.isFinite(Number(params.steps))) task.steps = Number(params.steps);
    if (params.CFGScale != null && Number.isFinite(Number(params.CFGScale))) task.CFGScale = Number(params.CFGScale);
    if (params.seed != null && Number.isFinite(Number(params.seed))) task.seed = Number(params.seed);

    const sources = sourceImages(params);
    if (sources.length > 0) {
      task.inputs = { seedImage: asDataUrl(sources[0]) };
      if (params.strength != null && Number.isFinite(Number(params.strength))) task.strength = Number(params.strength);
    }

    const finalTask = applyRawOverride(task, params.rawRequestOverride);

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify([finalTask]),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const payload = await res.json();
    // Errors arrive either as a top-level `errors[]` array (REST/WS, see the
    // authentication docs) or as a per-task `error` inside `data[]`.
    const topLevelError = Array.isArray(payload?.errors) ? payload.errors[0] : payload?.error;
    if (topLevelError) {
      throw new Error(`Runware: ${topLevelError.message || topLevelError.errorMessage || topLevelError}`);
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : undefined;
    if (first?.error) throw new Error(`Runware: ${first.errorMessage || first.error}`);
    const url: string | undefined = first?.imageURL || first?.imageDataURI;
    if (!url) throw new Error("Runware returned no image data");

    return { imageDataUrl: await toDataUrl(url, request.signal), model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      // A minimal ping task authenticates the key without generating anything.
      const res = await fetch("https://api.runware.ai/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify([{ taskType: "authentication", apiKey }]),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      const payload = await res.json();
      const topLevelError = Array.isArray(payload?.errors) ? payload.errors[0] : payload?.error;
      if (topLevelError) throw new Error(String(topLevelError.message || topLevelError.errorMessage || topLevelError));
      const err = Array.isArray(payload?.data) ? payload.data[0]?.error : undefined;
      if (err) throw new Error(String(payload.data[0]?.errorMessage || err));
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
