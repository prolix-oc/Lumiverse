import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { asDataUrl, pollUntil, sourceImages, toDataUrl, trimBaseUrl } from "./shared";

/**
 * Black Forest Labs FLUX image generation (`POST /v1/{model}`).
 *
 * Submission returns `{ id, polling_url }`; the returned `polling_url` is
 * polled until `status` is `Ready` (or `Error`). Result URLs expire in about
 * ten minutes, so `result.sample` is downloaded immediately.
 *
 * @see https://docs.bfl.ai/quick_start/generating_images
 */
export class BlackForestLabsImageProvider implements ImageProvider {
  readonly name = "bfl";
  readonly displayName = "Black Forest Labs";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 256,
        max: 2048,
        step: 32,
        description: "Image width in pixels (model-dependent)",
      },
      height: {
        type: "integer",
        min: 256,
        max: 2048,
        step: 32,
        description: "Image height in pixels (model-dependent)",
      },
      aspectRatio: {
        type: "select",
        default: "",
        description: "Use an aspect ratio instead of explicit width/height (model-dependent)",
        options: [
          { id: "", label: "Explicit width/height" },
          { id: "1:1", label: "1:1 (Square)" },
          { id: "16:9", label: "16:9" },
          { id: "9:16", label: "9:16" },
          { id: "3:2", label: "3:2" },
          { id: "2:3", label: "2:3" },
          { id: "4:3", label: "4:3" },
          { id: "3:4", label: "3:4" },
          { id: "21:9", label: "21:9" },
        ],
      },
      guidance: {
        type: "number",
        min: 1,
        max: 10,
        step: 0.1,
        description: "Classifier-free guidance scale",
        group: "advanced",
      },
      steps: {
        type: "integer",
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      promptUpsampling: {
        type: "boolean",
        default: false,
        description: "Upsample the prompt for extra detail (model-dependent)",
        group: "advanced",
      },
      resolution: {
        type: "select",
        default: "",
        description: "Output resolution tier (FLUX 3 Image / Klein; overrides width/height)",
        options: [
          { id: "", label: "Default (1k)" },
          { id: "768sq", label: "768 x 768" },
          { id: "1k", label: "1K (about 1 MP)" },
          { id: "1.5k", label: "1.5K (about 2 MP)" },
          { id: "2k", label: "2K (about 4 MP)" },
          { id: "4k", label: "4K (about 16 MP)" },
          { id: "match_input", label: "Match input (edits)" },
        ],
        group: "advanced",
      },
      outputFormat: {
        type: "select",
        default: "",
        description: "Output file format",
        options: [
          { id: "", label: "Provider default" },
          { id: "jpeg", label: "JPEG" },
          { id: "png", label: "PNG" },
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
        description: "Raw JSON merged into the request body",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "flux-2-pro-preview", label: "FLUX.2 Pro (preview)" },
      { id: "flux-2-pro", label: "FLUX.2 Pro" },
      { id: "flux-2-flex", label: "FLUX.2 Flex" },
      { id: "flux-2-max", label: "FLUX.2 Max" },
      { id: "flux-2-klein-9b-preview", label: "FLUX.2 Klein 9B (preview)" },
      { id: "flux-2-klein-9b", label: "FLUX.2 Klein 9B" },
      { id: "flux-2-klein-4b", label: "FLUX.2 Klein 4B" },
      { id: "flux-3-image", label: "FLUX 3 Image" },
      { id: "flux-3-image-klein", label: "FLUX 3 Image Klein" },
      { id: "flux-kontext-pro", label: "FLUX.1 Kontext Pro" },
      { id: "flux-kontext-max", label: "FLUX.1 Kontext Max" },
      { id: "flux-pro-1.1", label: "FLUX 1.1 Pro" },
      { id: "flux-pro-1.1-ultra", label: "FLUX 1.1 Pro Ultra" },
      { id: "flux-dev", label: "FLUX Dev" },
    ],
    defaultUrl: "https://api.bfl.ai/v1",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/v1(\/.*)?$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "flux-pro-1.1";
    const base = this.baseUrl(apiUrl);

    // The FLUX family splits into several request shapes (verified against the
    // published OpenAPI spec at https://api.bfl.ai/openapi.json):
    //  - FLUX.2 (pro/flex/max/klein): width/height + `input_image` (up to 8)
    //  - FLUX 3 (image/image-klein): width/height + aspect_ratio + `images[]`;
    //    `flux-3-image` sets additionalProperties:false and accepts neither
    //    `seed` nor `output_format`
    //  - Kontext: aspect_ratio + `input_image` (up to 4)
    //  - FLUX 1.x (pro-1.1 / pro-1.1-ultra / dev): width/height or aspect_ratio
    //    (Ultra) + `image_prompt`
    const isFlux2 = model.startsWith("flux-2");
    const isFlux3 = model.startsWith("flux-3");
    const isKlein = model.includes("klein");
    const isUltra = model.includes("ultra");
    const isKontext = model.includes("kontext");
    const isFlex = model.includes("flex");
    const isDev = model.includes("dev");
    const isPro11 = model.startsWith("flux-pro-1.1") && !isUltra;
    const supportsGuidance = isFlux2 ? isFlex : isFlux3 ? false : isDev;
    const supportsSteps = isFlux2 ? isFlex : isFlux3 ? isKlein : isDev;
    const supportsSeed = isFlux3 ? isKlein : true;
    // `flux-3-image` (the non-Klein variant) is the only endpoint that rejects
    // `output_format`.
    const supportsOutputFormat = !(model === "flux-3-image");

    const body: Record<string, any> = { prompt: request.prompt };
    if (isUltra || isKontext) {
      if (params.aspectRatio) body.aspect_ratio = String(params.aspectRatio);
    } else if (isFlux3) {
      if (params.width != null) body.width = Number(params.width);
      if (params.height != null) body.height = Number(params.height);
      if (params.aspectRatio) body.aspect_ratio = String(params.aspectRatio);
    } else {
      if (params.width != null) body.width = Number(params.width);
      if (params.height != null) body.height = Number(params.height);
    }
    if (supportsGuidance && params.guidance != null && Number.isFinite(Number(params.guidance))) {
      body.guidance = Number(params.guidance);
    }
    if (supportsSteps && params.steps != null && Number.isFinite(Number(params.steps))) {
      body.steps = Number(params.steps);
    }
    if (typeof params.promptUpsampling === "boolean") {
      if (isFlux2 && !isFlex && !isKlein) {
        // FLUX.2 Pro / Max upsample by default; `disable_pup` turns it off.
        body.disable_pup = !params.promptUpsampling;
      } else if (isFlex || isUltra || isKontext || isDev || isPro11) {
        // Flex, Ultra, Kontext, Dev and 1.1 Pro use the positive flag. FLUX.2
        // Klein has no prompt-upsampling field, so nothing is sent for it.
        body.prompt_upsampling = params.promptUpsampling;
      }
    }
    if (supportsSeed && params.seed != null && Number.isFinite(Number(params.seed))) {
      body.seed = Number(params.seed);
    }
    // `resolution` is a FLUX 3 tier that overrides width/height.
    if (isFlux3 && params.resolution) body.resolution = String(params.resolution);
    if (supportsOutputFormat && params.outputFormat) body.output_format = String(params.outputFormat);

    const sources = sourceImages(params);
    if (sources.length > 0) {
      if (isFlux3) {
        body.images = sources.map((src) => asDataUrl(src));
      } else if (isFlux2 || isKontext) {
        // FLUX.2 takes up to 8 references as input_image..input_image_8;
        // Kontext takes up to 4.
        const limit = isFlux2 ? 8 : 4;
        sources.slice(0, limit).forEach((src, index) => {
          body[index === 0 ? "input_image" : `input_image_${index + 1}`] = asDataUrl(src);
        });
      } else {
        body.image_prompt = asDataUrl(sources[0]);
      }
    }

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const submit = await fetch(`${base}/v1/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-key": apiKey },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!submit.ok) await throwProviderResponseError(this.displayName, "image generate", submit);

    const job = await submit.json();
    const pollingUrl: string | undefined = job?.polling_url;
    if (!pollingUrl) throw new Error("Black Forest Labs returned no polling URL");

    const result = await pollUntil<{ sample: string }>({
      intervalMs: 1000,
      timeoutMs: 300_000,
      signal: request.signal,
      check: async () => {
        const res = await fetch(pollingUrl, { headers: { "x-key": apiKey }, signal: request.signal });
        if (!res.ok) await throwProviderResponseError(this.displayName, "image polling", res);
        const status = await res.json();
        const state = String(status?.status || "");
        if (state === "Ready") {
          const sample = status?.result?.sample;
          if (!sample) return { done: true, error: "Black Forest Labs returned no image" };
          return { done: true, value: { sample } };
        }
        if (state === "Error" || state === "Failed" || state === "Content Moderated" || state === "Request Moderated") {
          return { done: true, error: status?.result?.error || `Black Forest Labs job ${state}` };
        }
        return { done: false };
      },
    });

    return { imageDataUrl: await toDataUrl(result.sample, request.signal), model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      // `/v1/credits` authenticates the key (200 with a balance). `get_result`
      // is not usable here: it answers 404 for an unknown task regardless of
      // whether the key is valid, so it cannot distinguish a bad key.
      const res = await fetch("https://api.bfl.ai/v1/credits", {
        headers: { "x-key": apiKey },
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
