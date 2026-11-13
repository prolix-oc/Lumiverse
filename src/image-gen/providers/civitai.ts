import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { pollUntil, toDataUrl, trimBaseUrl } from "./shared";

/**
 * Civitai orchestration — native workflow API.
 *
 * `POST /v2/consumer/workflows?wait=60` runs an image-gen workflow. With
 * `wait=0` the call returns immediately and the workflow is polled via
 * `GET /v2/consumer/workflows/{id}`. Blob result URLs have a TTL, so they are
 * downloaded immediately.
 *
 * Only the `imageGen` step (`createImage`) is modelled. LoRAs are sent as an
 * `{ airUrn: strength }` map, matching the Anima recipe. Free-tier work is
 * selected with `tier: "free"`; every step must then use a free-tier model.
 *
 * @see https://developer.civitai.com/orchestration/recipes/anima
 */
export class CivitaiImageProvider implements ImageProvider {
  readonly name = "civitai";
  readonly displayName = "Civitai";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 64,
        max: 2048,
        step: 16,
        default: 1024,
        description: "Image width in pixels (multiple of 16)",
      },
      height: {
        type: "integer",
        min: 64,
        max: 2048,
        step: 16,
        default: 1024,
        description: "Image height in pixels (multiple of 16)",
      },
      ecosystem: {
        type: "select",
        default: "anima",
        description: "Workflow ecosystem (which model family the step runs)",
        options: [
          { id: "anima", label: "Anima" },
          { id: "sdxl", label: "SDXL" },
          { id: "sd1", label: "SD 1.5" },
          { id: "flux1", label: "FLUX.1" },
        ],
      },
      engine: {
        type: "select",
        default: "sdcpp",
        description: "Inference engine",
        options: [
          { id: "sdcpp", label: "stable-diffusion.cpp" },
          { id: "comfy", label: "ComfyUI" },
        ],
        group: "advanced",
      },
      cfgScale: {
        type: "number",
        min: 1,
        max: 20,
        step: 0.5,
        default: 4,
        description: "Classifier-free guidance scale",
        group: "advanced",
      },
      steps: {
        type: "integer",
        min: 1,
        max: 100,
        default: 30,
        description: "Number of diffusion sampling steps",
        group: "advanced",
      },
      quantity: {
        type: "integer",
        min: 1,
        max: 12,
        default: 1,
        description: "Number of images to generate",
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      loras: {
        type: "string",
        description: 'JSON map of LoRA AIR URN to strength, e.g. {"urn:air:anima:lora:civitai:123456@789012": 0.8}',
        group: "advanced",
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
      whatif: {
        type: "boolean",
        default: false,
        description: "Cost preview only — returns the Buzz cost without generating",
        group: "advanced",
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the imageGen step input",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "anima", label: "Anima" },
      { id: "urn:air:sdxl:checkpoint:civitai:101055@128078", label: "SDXL checkpoint (AIR URN)" },
    ],
    defaultUrl: "https://orchestration.civitai.com",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/v2\/.*$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "anima";
    const base = this.baseUrl(apiUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    const input: Record<string, any> = {
      engine: params.engine || "sdcpp",
      ecosystem: params.ecosystem || "anima",
      operation: "createImage",
      prompt: request.prompt,
      width: params.width != null ? Number(params.width) : 1024,
      height: params.height != null ? Number(params.height) : 1024,
    };
    // Anima ships its own model; SD checkpoints require the selected AIR URN.
    if (model !== "anima") input.model = model;
    if (params.seed != null && Number.isFinite(Number(params.seed))) input.seed = Number(params.seed);
    if (request.negativePrompt) input.negativePrompt = request.negativePrompt;
    if (params.cfgScale != null && Number.isFinite(Number(params.cfgScale))) input.cfgScale = Number(params.cfgScale);
    if (params.steps != null && Number.isFinite(Number(params.steps))) input.steps = Number(params.steps);
    if (params.quantity != null && Number.isFinite(Number(params.quantity))) input.quantity = Number(params.quantity);
    const loras = parseLoras(params.loras);
    if (loras) input.loras = loras;

    const stepInput = applyRawOverride(input, params.rawRequestOverride);

    const body: Record<string, any> = { steps: [{ $type: "imageGen", input: stepInput }] };
    if (params.tier === "free") body.tier = "free";

    // `whatif` is a query flag: the workflow is priced but not submitted, and
    // the response carries `cost` instead of images.
    const dryRun = params.whatif === true;
    const query = new URLSearchParams({ wait: "60" });
    if (dryRun) query.set("whatif", "true");

    const submit = await fetch(`${base}/v2/consumer/workflows?${query.toString()}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!submit.ok) await throwProviderResponseError(this.displayName, "image generate", submit);

    let workflow = await submit.json();
    if (dryRun) {
      const cost = workflow?.cost?.total ?? workflow?.cost ?? "unknown";
      throw new Error(`Civitai cost estimate (whatif): ${JSON.stringify(cost)} Buzz — disable "Cost preview only" to generate.`);
    }
    const workflowId = workflow?.id || workflow?.workflowId;
    if (!hasImages(workflow) && workflowId) {
      workflow = await pollUntil<Record<string, any>>({
        intervalMs: 2000,
        timeoutMs: 300_000,
        signal: request.signal,
        check: async () => {
          const res = await fetch(`${base}/v2/consumer/workflows/${workflowId}`, { headers, signal: request.signal });
          if (!res.ok) await throwProviderResponseError(this.displayName, "image polling", res);
          const current = await res.json();
          const state = String(current?.status || "").toLowerCase();
          if (hasImages(current)) return { done: true, value: current };
          if (state === "failed" || state === "canceled" || state === "cancelled") {
            return { done: true, error: current?.error || `Civitai workflow ${state}` };
          }
          return { done: false };
        },
      });
    }

    const url = firstImageUrl(workflow);
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

function parseLoras(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, Number(v)]));
    }
  } catch {
    throw new Error("Civitai LoRAs must be a JSON object mapping AIR URN to strength");
  }
  return undefined;
}

function firstImageUrl(workflow: any): string | undefined {
  // Read generated output only: workflows can also echo URLs in their inputs.
  for (const step of workflow?.steps ?? []) {
    for (const image of step?.output?.images ?? []) {
      if (typeof image?.url === "string" && /^https?:/.test(image.url)) return image.url;
    }
  }
  return undefined;
}

function hasImages(workflow: any): boolean {
  return !!firstImageUrl(workflow);
}
