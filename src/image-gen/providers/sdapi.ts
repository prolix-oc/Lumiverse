import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities, ImageParameterSchemaMap } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride, PROTECTED_RAW_OVERRIDE_KEYS } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/** Clamp a number into the 0..1 range (denoising strength). */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

const PARAMETERS: ImageParameterSchemaMap = {
  prompt: {
    type: "string",
    description: "Text prompt for the image",
  },
  negativePrompt: {
    type: "string",
    description: "Negative prompt — things to exclude from the image",
  },
  width: {
    type: "integer",
    min: 64,
    max: 4096,
    default: 1024,
    step: 64,
    description: "Image width in pixels",
  },
  height: {
    type: "integer",
    min: 64,
    max: 4096,
    default: 1024,
    step: 64,
    description: "Image height in pixels",
  },
  steps: {
    type: "integer",
    min: 1,
    max: 150,
    default: 20,
    description: "Number of sampling steps",
  },
  cfg: {
    type: "number",
    min: 1,
    max: 30,
    default: 7,
    step: 0.5,
    description: "Classifier-free guidance scale",
  },
  sampler_name: {
    type: "string",
    description: "Sampler name (e.g. euler, euler_ancestral, dpmpp_2m, ddim)",
    group: "advanced",
    modelSubtype: "samplers",
  },
  scheduler: {
    type: "string",
    description: "Scheduler name (e.g. normal, karras, sgm_uniform)",
    group: "advanced",
    modelSubtype: "schedulers",
  },
  seed: {
    type: "integer",
    default: -1,
    description: "Random seed (-1 for random)",
    group: "advanced",
  },
  batch_size: {
    type: "integer",
    min: 1,
    max: 16,
    default: 1,
    description: "Number of images to generate",
    group: "advanced",
  },
  clip_skip: {
    type: "integer",
    min: 1,
    max: 12,
    default: 1,
    description: "CLIP skip — layers to ignore from the text encoder (higher = more abstract)",
    group: "advanced",
  },
  mode: {
    type: "select",
    default: "txt2img",
    description: "Generation mode",
    group: "mode",
    options: [
      { id: "txt2img", label: "Text to Image" },
      { id: "img2img", label: "Image to Image" },
    ],
  },
  denoising_strength: {
    type: "number",
    min: 0,
    max: 1,
    default: 0.75,
    description: "Denoising strength for img2img (0 = keep original, 1 = fully regenerated)",
    group: "mode",
  },
  init_images: {
    type: "string",
    description:
      "Manual img2img init image (base64 / data URL, or a JSON array of them). Optional override — the reference-image picker and character/persona avatars are used automatically when present.",
    group: "mode",
  },
  enable_hr: {
    type: "boolean",
    default: false,
    description: "Enable high-resolution fix (upscaling pass after initial generation)",
    group: "advanced",
  },
  hr_upscaler: {
    type: "string",
    description: "Upscaler model for highres fix (e.g. Lanczos, Nearest)",
    group: "advanced",
  },
  hr_scale: {
    type: "number",
    min: 1,
    max: 8,
    default: 2,
    description: "Scale factor for highres fix",
    group: "advanced",
  },
  hr_resize_x: {
    type: "integer",
    min: 0,
    description: "Target width for highres fix (0 = use hr_scale)",
    group: "advanced",
  },
  hr_resize_y: {
    type: "integer",
    min: 0,
    description: "Target height for highres fix (0 = use hr_scale)",
    group: "advanced",
  },
  hr_steps: {
    type: "integer",
    min: 0,
    description: "Steps for highres second pass (0 = reuse main steps)",
    group: "advanced",
  },
  lora: {
    type: "string",
    description: 'JSON array of LoRA entries: [{ "path": "model.safetensors", "multiplier": 0.8 }]',
    group: "models",
    modelSubtype: "loras",
  },
  rawRequestOverride: {
    type: "string",
    description: "Raw JSON merged into the request body for advanced usage",
    group: "advanced",
  },
};

/** Protected keys for SD API raw request overrides — prevents smuggling auth/model fields. */
const SDAPI_PROTECTED_KEYS = new Set<string>([
  ...PROTECTED_RAW_OVERRIDE_KEYS,
  "lora",
  "loras",
  "init_images",
  "extra_images",
]);

/**
 * SD API provider for stable-diffusion.cpp and AUTOMATIC1111 WebUI compatibility.
 *
 * Targets the `/sdapi/v1/` endpoint family:
 * - `POST /sdapi/v1/txt2img` — text-to-image generation
 * - `POST /sdapi/v1/img2img` — image-to-image generation
 * - `GET  /sdapi/v1/sd-models` — checkpoint listing
 * - `GET  /sdapi/v1/loras` — LoRA listing
 * - `GET  /sdapi/v1/samplers` — sampler listing
 * - `GET  /sdapi/v1/schedulers` — scheduler listing
 */
export class SdApiImageProvider implements ImageProvider {
  readonly name = "sdapi";
  readonly displayName = "SD API (stable-diffusion.cpp / A1111)";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: PARAMETERS,
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:7860",
  };

  // ── Helpers ───────────────────────────────────────────────────────────

  private baseUrl(apiUrl: string): string {
    return (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
  }

  private apiPath(apiUrl: string, path: string): string {
    return `${this.baseUrl(apiUrl).replace(/\/+$/, "")}${path}`;
  }

  /** Parse the `/sdapi/v1/sd-models` response into a model list. */
  private parseSdModels(data: unknown): Array<{ id: string; label: string }> {
    const models = Array.isArray(data) ? data : [];
    return models
      .map((m: any) => ({
        id: String(m?.model_name || m?.title || m?.filename || "").trim(),
        label: String(m?.title || m?.model_name || m?.filename || "").trim(),
      }))
      .filter((m: { id: string; label: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));
  }

  /** Parse the `/sdapi/v1/loras` response into a model list. */
  private parseLoras(data: unknown): Array<{ id: string; label: string }> {
    const items = Array.isArray(data) ? data : [];
    return items
      .map((l: any) => ({
        id: String(l?.name || l?.path || "").trim(),
        label: String(l?.name || l?.path || "").trim(),
      }))
      .filter((m: { id: string; label: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));
  }

  /** Parse the `/sdapi/v1/samplers` response into a model list. */
  private parseSamplers(data: unknown): Array<{ id: string; label: string }> {
    const items = Array.isArray(data) ? data : [];
    return items
      .map((s: any) => ({
        id: String(s?.name || s?.alias || "").trim(),
        label: String(s?.name || s?.alias || "").trim(),
      }))
      .filter((m: { id: string; label: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));
  }

  /** Parse the `/sdapi/v1/schedulers` response into a model list. */
  private parseSchedulers(data: unknown): Array<{ id: string; label: string }> {
    const items = Array.isArray(data) ? data : [];
    return items
      .map((s: any) => ({
        id: String(s?.name || s?.label || "").trim(),
        label: String(s?.label || s?.name || "").trim(),
      }))
      .filter((m: { id: string; label: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));
  }

  /** Parse txt2img/img2img response — extract first image as data URL. */
  private parseResponse(data: Record<string, any>, mimeType = "image/png"): string {
    const images = Array.isArray(data?.images) ? data.images : [];
    if (images.length === 0) {
      throw new Error("SD API returned no images");
    }
    const b64 = images[0];
    if (typeof b64 !== "string") {
      throw new Error("SD API returned non-string image data");
    }
    return `data:${mimeType};base64,${b64}`;
  }

  // ── Build request body ────────────────────────────────────────────────

  /** Build the txt2img request body from the ImageGenRequest. */
  private buildTxt2ImgBody(request: ImageGenRequest): Record<string, any> {
    const p = request.parameters ?? {};

    const body: Record<string, any> = {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt || p.negativePrompt || "",
      model: request.model || "",
      width: Number(p.width) || 1024,
      height: Number(p.height) || 1024,
      steps: Number(p.steps) || 20,
      cfg_scale: Number(p.cfg) || 7,
      seed: typeof p.seed === "number" && Number.isFinite(p.seed) ? Number(p.seed) : -1,
      batch_size: Number(p.batch_size) || 1,
    };

    if (p.sampler_name) body.sampler_name = String(p.sampler_name);
    if (p.scheduler) body.scheduler = String(p.scheduler);
    if (p.clip_skip != null && Number.isFinite(Number(p.clip_skip))) body.clip_skip = Number(p.clip_skip);

    // Highres fix
    if (p.enable_hr) {
      body.enable_hr = !!p.enable_hr;
      body.hr_upscaler = p.hr_upscaler ? String(p.hr_upscaler) : undefined;
      body.hr_scale = Number(p.hr_scale) || 2;
      body.hr_resize_x = p.hr_resize_x != null ? Number(p.hr_resize_x) : 0;
      body.hr_resize_y = p.hr_resize_y != null ? Number(p.hr_resize_y) : 0;
      body.hr_steps = p.hr_steps != null ? Number(p.hr_steps) : 0;
      body.denoising_strength = p.denoising_strength != null ? Number(p.denoising_strength) : 0.7;
    }

    // LoRA — parse JSON string into structured array
    if (p.lora) {
      try {
        const loraParsed = JSON.parse(String(p.lora));
        if (Array.isArray(loraParsed)) {
          body.lora = loraParsed;
        }
      } catch {
        // Invalid JSON — skip silently
      }
    }

    return applyRawOverride(body, p.rawRequestOverride, SDAPI_PROTECTED_KEYS);
  }

  /**
   * Collect img2img init images, preferring the orchestrated source set
   * (manual reference uploads + character/persona avatars, resolved upstream
   * into `resolvedSourceImages` as raw-base64 `{ data, mimeType }`) and falling
   * back to the manual `init_images` paste field. stable-diffusion.cpp accepts
   * both raw base64 and data URLs in `init_images`; we normalise resolved
   * sources to data URLs so the MIME type travels with the bytes.
   */
  private collectInitImages(p: Record<string, any>): string[] {
    const out: string[] = [];

    const sources: Array<{ data?: string; mimeType?: string }> = Array.isArray(p.resolvedSourceImages)
      ? p.resolvedSourceImages
      : Array.isArray(p.referenceImages)
        ? p.referenceImages
        : [];
    for (const src of sources) {
      if (!src?.data) continue;
      const data = String(src.data);
      out.push(data.startsWith("data:") ? data : `data:${src.mimeType || "image/png"};base64,${data}`);
    }

    // Manual paste field — a JSON array of strings, or a single base64/data URL.
    if (p.init_images) {
      try {
        const parsed = JSON.parse(String(p.init_images));
        if (Array.isArray(parsed)) out.push(...parsed.map((s: unknown) => String(s)));
        else out.push(String(p.init_images));
      } catch {
        out.push(String(p.init_images));
      }
    }

    return out;
  }

  /** Build the img2img request body from the ImageGenRequest. */
  private buildImg2ImgBody(request: ImageGenRequest): Record<string, any> {
    const p = request.parameters ?? {};

    const denoise = Number(p.denoising_strength);
    const body: Record<string, any> = {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt || p.negativePrompt || "",
      model: request.model || "",
      width: Number(p.width) || 1024,
      height: Number(p.height) || 1024,
      steps: Number(p.steps) || 20,
      cfg_scale: Number(p.cfg) || 7,
      seed: typeof p.seed === "number" && Number.isFinite(p.seed) ? Number(p.seed) : -1,
      batch_size: Number(p.batch_size) || 1,
      // SD.cpp clamps this server-side too, but clamp here for an explicit contract.
      denoising_strength: clamp01(Number.isFinite(denoise) ? denoise : 0.75),
      init_images: this.collectInitImages(p),
    };

    if (p.sampler_name) body.sampler_name = String(p.sampler_name);
    if (p.scheduler) body.scheduler = String(p.scheduler);
    if (p.clip_skip != null && Number.isFinite(Number(p.clip_skip))) body.clip_skip = Number(p.clip_skip);

    // LoRA
    if (p.lora) {
      try {
        const loraParsed = JSON.parse(String(p.lora));
        if (Array.isArray(loraParsed)) {
          body.lora = loraParsed;
        }
      } catch {
        // Invalid JSON — skip silently
      }
    }

    return applyRawOverride(body, p.rawRequestOverride, SDAPI_PROTECTED_KEYS);
  }

  // ── ImageProvider interface ───────────────────────────────────────────

  async generate(
    apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): Promise<ImageGenResponse> {
    const p = request.parameters ?? {};

    // img2img engages when the user picks it explicitly, or whenever a source
    // image is supplied (reference upload, character/persona avatar, or a manual
    // init image) — txt2img can't consume an init image, so its presence is the
    // signal. This mirrors the "attach an image and it just works" behaviour of
    // the other img2img providers.
    const hasSourceImages =
      (Array.isArray(p.resolvedSourceImages) && p.resolvedSourceImages.length > 0) ||
      (Array.isArray(p.referenceImages) && p.referenceImages.length > 0) ||
      !!p.init_images;
    const mode = p.mode === "img2img" || hasSourceImages ? "img2img" : "txt2img";

    let endpoint: string;
    let body: Record<string, any>;

    if (mode === "img2img") {
      endpoint = this.apiPath(apiUrl, "/sdapi/v1/img2img");
      body = this.buildImg2ImgBody(request);
    } else {
      endpoint = this.apiPath(apiUrl, "/sdapi/v1/txt2img");
      body = this.buildTxt2ImgBody(request);
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      await throwProviderResponseError(this.displayName, `${mode} generation`, res);
    }

    const data = (await res.json()) as Record<string, any>;
    const imageDataUrl = this.parseResponse(data);

    return {
      imageDataUrl,
      model: request.model || "sdapi-model",
      provider: this.name,
    };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const url = this.apiPath(apiUrl, "/sdapi/v1/options");
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers,
      });
      if (!res.ok) {
        await throwProviderResponseError(this.displayName, "connection check", res);
      }
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "connection check",
        detail: err instanceof Error ? err.message : "network request failed",
        retryable: true,
      });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const url = this.apiPath(apiUrl, "/sdapi/v1/sd-models");
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const data = await fetchProviderJson<any>(this.displayName, "model listing", url, {
      signal: AbortSignal.timeout(10000),
      headers,
    });
    return this.parseSdModels(data);
  }

  async listModelsBySubtype(
    apiKey: string,
    apiUrl: string,
    subtype: string,
  ): Promise<Array<{ id: string; label: string }>> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    switch (subtype) {
      case "loras":
      case "lora": {
        const url = this.apiPath(apiUrl, "/sdapi/v1/loras");
        const data = await fetchProviderJson<any>(this.displayName, "LoRA listing", url, {
          signal: AbortSignal.timeout(10000),
          headers,
        });
        return this.parseLoras(data);
      }
      case "samplers":
      case "sampler_name": {
        const url = this.apiPath(apiUrl, "/sdapi/v1/samplers");
        const data = await fetchProviderJson<any>(this.displayName, "sampler listing", url, {
          signal: AbortSignal.timeout(10000),
          headers,
        });
        return this.parseSamplers(data);
      }
      case "schedulers":
      case "scheduler": {
        const url = this.apiPath(apiUrl, "/sdapi/v1/schedulers");
        const data = await fetchProviderJson<any>(this.displayName, "scheduler listing", url, {
          signal: AbortSignal.timeout(10000),
          headers,
        });
        return this.parseSchedulers(data);
      }
      default:
        return [];
    }
  }
}
