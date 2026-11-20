import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { pollUntil, toDataUrl, trimBaseUrl } from "./shared";

/**
 * Leonardo.ai image generation (`POST /api/rest/v1/generations`).
 *
 * Generation is asynchronous: submission returns `sdGenerationJob.generationId`
 * and the job is polled until its status leaves `PENDING`. Model ids are UUIDs;
 * the model field accepts either a UUID or a model name that the provider
 * resolves via the models endpoint.
 *
 * @see https://docs.leonardo.ai/docs/phoenix
 */
export class LeonardoImageProvider implements ImageProvider {
  readonly name = "leonardo";
  readonly displayName = "Leonardo.Ai";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 256,
        max: 1536,
        step: 8,
        default: 1024,
        description: "Image width in pixels",
      },
      height: {
        type: "integer",
        min: 256,
        max: 1536,
        step: 8,
        default: 1024,
        description: "Image height in pixels",
      },
      numImages: {
        type: "integer",
        min: 1,
        max: 8,
        default: 1,
        description: "Number of images to generate",
        group: "advanced",
      },
      contrast: {
        type: "number",
        min: 1,
        max: 5,
        step: 0.5,
        description: "Contrast (required for Phoenix models: 3, 3.5, or 4)",
        group: "advanced",
      },
      alchemy: {
        type: "boolean",
        default: false,
        description: "Enable Alchemy enhancement",
        group: "advanced",
      },
      ultra: {
        type: "boolean",
        default: false,
        description: "Enable Ultra mode",
        group: "advanced",
      },
      enhancePrompt: {
        type: "boolean",
        default: false,
        description: "Let Leonardo enhance the prompt",
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
    modelListStyle: "dynamic",
    staticModels: [
      { id: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3", label: "Phoenix 1.0" },
      { id: "6bef9f1b-29cb-40c7-b9df-32b51c1f67d3", label: "Leonardo Creative" },
    ],
    defaultUrl: "https://cloud.leonardo.ai/api/rest/v1",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/(generations|models).*$/, "");
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const base = this.baseUrl(apiUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    let modelId = request.model || this.capabilities.staticModels![0].id;
    if (!looksLikeUuid(modelId)) {
      const resolved = await this.resolveModelId(modelId, base, headers, request.signal);
      if (resolved) modelId = resolved;
    }

    const body: Record<string, any> = { modelId, prompt: request.prompt };
    if (params.width != null) body.width = Number(params.width);
    if (params.height != null) body.height = Number(params.height);
    if (params.numImages != null && Number.isFinite(Number(params.numImages))) body.num_images = Number(params.numImages);
    if (params.contrast != null && Number.isFinite(Number(params.contrast))) body.contrast = Number(params.contrast);
    if (typeof params.alchemy === "boolean") body.alchemy = params.alchemy;
    if (typeof params.ultra === "boolean") body.ultra = params.ultra;
    if (typeof params.enhancePrompt === "boolean") body.enhancePrompt = params.enhancePrompt;
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (params.seed != null && Number.isFinite(Number(params.seed))) body.seed = Number(params.seed);

    const finalBody = applyRawOverride(body, params.rawRequestOverride);

    const submit = await fetch(`${base}/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!submit.ok) await throwProviderResponseError(this.displayName, "image generate", submit);

    const job = await submit.json();
    const generationId: string | undefined = job?.sdGenerationJob?.generationId;
    if (!generationId) throw new Error("Leonardo returned no generation id");

    const result = await pollUntil<{ url: string }>({
      intervalMs: 2000,
      timeoutMs: 300_000,
      signal: request.signal,
      check: async () => {
        const res = await fetch(`${base}/generations/${generationId}`, { headers, signal: request.signal });
        if (!res.ok) await throwProviderResponseError(this.displayName, "image polling", res);
        const status = await res.json();
        const generation = status?.generations_by_pk;
        const state = String(generation?.status || "");
        if (state === "COMPLETE") {
          const url = generation?.generated_images?.[0]?.url;
          if (!url) return { done: true, error: "Leonardo returned no image" };
          return { done: true, value: { url } };
        }
        if (state === "FAILED") return { done: true, error: "Leonardo generation failed" };
        return { done: false };
      },
    });

    return { imageDataUrl: await toDataUrl(result.url, request.signal), model: modelId, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://cloud.leonardo.ai/api/rest/v1/me", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models?limit=100`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "model listing", res);
      const data = await res.json();
      const models: Array<{ id: string; label: string }> = [...(data?.custom_models || []), ...(data?.platform_models || [])]
        .map((m: any) => ({ id: String(m?.id || "").trim(), label: String(m?.name || m?.id || "").trim() }))
        .filter((m: { id: string }) => !!m.id);
      models.sort((a, b) => a.label.localeCompare(b.label));
      return models.length > 0 ? models : this.capabilities.staticModels || [];
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      return this.capabilities.staticModels || [];
    }
  }

  private async resolveModelId(
    name: string,
    base: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const res = await fetch(`${base}/models?limit=100`, { headers, signal });
      if (!res.ok) return undefined;
      const data = await res.json();
      const all = [...(data?.custom_models || []), ...(data?.platform_models || [])];
      const match = all.find((m: any) => String(m?.name || "").toLowerCase() === name.toLowerCase());
      return match?.id ? String(match.id) : undefined;
    } catch {
      return undefined;
    }
  }
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
