import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { decodeImage, sourceImages, toDataUrl, trimBaseUrl, type SourceImage } from "./shared";

/** v2 models whose *generate* endpoint takes `multipart/form-data`. */
const GENERATE_MULTIPART_MODELS = new Set(["ideogram-4-5", "ideogram-3"]);

/** Append a pipeline source image to a multipart form as a file part. */
function appendImage(form: FormData, field: string, src: SourceImage, name: string): void {
  const { bytes, mimeType } = decodeImage(src);
  const ext = mimeType.split("/")[1] || "png";
  form.append(field, new Blob([bytes], { type: mimeType }), `${name}.${ext}`);
}

/** Where an edit (source image) request is routed for a given model. */
interface IdeogramEditRoute {
  action: "precise-edit" | "remix";
  /** Multipart field carrying the image being edited. */
  imageField: string;
  /** Multipart field for extra (non-edited) references, when the model has one. */
  referenceField?: string;
}

/**
 * Ideogram image generation (v2 `POST /v2/image/{action}/{model}`).
 *
 * The model is part of the path, and both the request shape and the edit
 * endpoint vary by model:
 *
 * | Model | Generate | Content type | Source image |
 * |---|---|---|---|
 * | 4.5 | `generate` | multipart | `images` (edit-in-place) or `precise-edit` |
 * | 4.0 | `generate` | JSON | `remix` |
 * | 3.0 | `generate` | multipart | `remix` |
 * | 2a / 2 | `generate` | JSON | none |
 *
 * Generate sizing also differs: 4.5 takes `size` (and `quality`), 4.0 takes
 * `resolution`, and 3.0 / 2.x take `aspect_ratio` plus `rendering_speed`. Auth
 * uses the `Api-Key` header rather than `Authorization: Bearer`.
 *
 * Results come back synchronously as `data[].url`; those URLs expire, so the
 * result is downloaded and inlined immediately.
 *
 * @see https://developer.ideogram.ai/v2/ideogram-api/api-overview
 */
export class IdeogramImageProvider implements ImageProvider {
  readonly name = "ideogram";
  readonly displayName = "Ideogram";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      size: {
        type: "string",
        default: "",
        description: "Output size as WIDTHxHEIGHT or 'auto' (Ideogram 4.5; leave blank for the model default)",
      },
      resolution: {
        type: "select",
        default: "",
        description: "Output resolution (Ideogram 4.0)",
        options: [
          { id: "", label: "Auto (from prompt)" },
          { id: "1024x1024", label: "1024x1024" },
          { id: "2048x2048", label: "2048x2048" },
          { id: "1440x2880", label: "1440x2880" },
          { id: "2880x1440", label: "2880x1440" },
          { id: "1280x720", label: "1280x720" },
          { id: "720x1280", label: "720x1280" },
        ],
      },
      aspectRatio: {
        type: "select",
        default: "1x1",
        description: "Output aspect ratio (Ideogram 3.0 / 2.x)",
        options: [
          { id: "1x1", label: "1x1 (Square)" },
          { id: "16x9", label: "16x9" },
          { id: "9x16", label: "9x16" },
          { id: "4x3", label: "4x3" },
          { id: "3x4", label: "3x4" },
          { id: "3x2", label: "3x2" },
          { id: "2x3", label: "2x3" },
          { id: "16x10", label: "16x10" },
          { id: "10x16", label: "10x16" },
          { id: "3x1", label: "3x1" },
          { id: "1x3", label: "1x3" },
        ],
      },
      renderingSpeed: {
        type: "select",
        default: "",
        description: "Latency/fidelity trade-off (Ideogram 4.0 / 3.0 / 2.x)",
        options: [
          { id: "", label: "Provider default" },
          { id: "TURBO", label: "Turbo" },
          { id: "DEFAULT", label: "Default" },
          { id: "QUALITY", label: "Quality" },
        ],
        group: "advanced",
      },
      quality: {
        type: "select",
        default: "",
        description: "Rendering quality (Ideogram 4.5)",
        options: [
          { id: "", label: "Provider default" },
          { id: "very_low", label: "Very low (needs a source image)" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        group: "advanced",
      },
      negativePrompt: {
        type: "string",
        description: "What to exclude (Ideogram 3.0 / 2.x generate only)",
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
      { id: "ideogram-4-5", label: "Ideogram 4.5" },
      { id: "ideogram-4", label: "Ideogram 4.0" },
      { id: "ideogram-3", label: "Ideogram 3.0" },
      { id: "ideogram-2a", label: "Ideogram 2a" },
    ],
    defaultUrl: "https://api.ideogram.ai",
  };

  private baseUrl(apiUrl: string): string {
    return trimBaseUrl(apiUrl || this.capabilities.defaultUrl).replace(/\/(v\d+)\/.*$/, "");
  }

  /** Edit route for a model, or null when it takes no source image. */
  private editRoute(model: string): IdeogramEditRoute | null {
    if (model.startsWith("ideogram-4-5")) {
      return { action: "precise-edit", imageField: "image", referenceField: "reference_images" };
    }
    if (model.startsWith("ideogram-4")) return { action: "remix", imageField: "image" };
    if (model.startsWith("ideogram-3")) {
      return { action: "remix", imageField: "image", referenceField: "style_reference_images" };
    }
    return null;
  }

  private isMultipart(model: string, action: string): boolean {
    return action !== "generate" || GENERATE_MULTIPART_MODELS.has(model);
  }

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "ideogram-4-5";
    const base = this.baseUrl(apiUrl);

    const sources = sourceImages(params);
    const edit = sources.length > 0 ? this.editRoute(model) : null;
    if (sources.length > 0 && !edit) {
      throw new Error(`Ideogram ${model} does not accept a source image`);
    }
    const action = edit?.action ?? "generate";

    const body: Record<string, any> = { prompt: request.prompt };
    if (action === "precise-edit") {
      // 4.5 precise-edit keeps the source's size and prices only by `quality`.
      if (params.quality) body.quality = String(params.quality);
    } else if (model.startsWith("ideogram-4-5")) {
      if (params.size) body.size = String(params.size);
      if (params.quality) body.quality = String(params.quality);
    } else if (model.startsWith("ideogram-4")) {
      // 4.0 generate takes `resolution`; its remix keeps the source's shape.
      if (action === "generate" && params.resolution) body.resolution = String(params.resolution);
      if (params.renderingSpeed) body.rendering_speed = String(params.renderingSpeed).toLowerCase();
    } else {
      if (params.aspectRatio) body.aspect_ratio = String(params.aspectRatio);
      if (params.renderingSpeed) body.rendering_speed = String(params.renderingSpeed).toLowerCase();
    }
    if (params.seed != null && Number.isFinite(Number(params.seed))) body.seed = Number(params.seed);
    // Only Ideogram 3.0 accepts `negative_prompt`; 4.x and 2a reject it.
    if (action === "generate" && model.startsWith("ideogram-3") && (request.negativePrompt || params.negativePrompt)) {
      body.negative_prompt = String(request.negativePrompt || params.negativePrompt);
    }

    const finalBody = applyRawOverride(body, params.rawRequestOverride);
    const multipart = this.isMultipart(model, action);

    const res = await fetch(`${base}/v2/image/${action}/${model}`, {
      method: "POST",
      headers: multipart ? { "Api-Key": apiKey } : { "Content-Type": "application/json", "Api-Key": apiKey },
      body: multipart ? this.buildMultipart(finalBody, edit, sources) : JSON.stringify(finalBody),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = await res.json();
    const url = data?.data?.[0]?.url;
    if (!url) throw new Error("Ideogram returned no image data");

    return { imageDataUrl: await toDataUrl(url, request.signal), model, provider: this.name };
  }

  /**
   * Ideogram's multipart endpoints take scalar options as plain fields and
   * images as file parts. The first source image is the one being edited (or,
   * on 4.5 generate, the first edited image); the rest become references.
   */
  private buildMultipart(body: Record<string, any>, edit: IdeogramEditRoute | null, sources: SourceImage[]): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value == null) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    if (sources.length > 0) {
      const imageField = edit?.imageField ?? "images";
      // 4.5 generate edits via `images` (all sources); edit routes take the
      // first source as the edited image and the rest as references.
      const edited = edit ? sources.slice(0, 1) : sources;
      const references = edit?.referenceField ? sources.slice(1) : [];
      for (const [i, src] of edited.entries()) appendImage(form, imageField, src, `source-${i}`);
      for (const [i, src] of references.entries()) appendImage(form, edit!.referenceField!, src, `reference-${i}`);
    }
    return form;
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      // `dry_run` is a query flag: the request is validated and priced without
      // generating or billing (the response is a `PriceQuote`).
      const form = new FormData();
      form.append("prompt", "connection test");
      const res = await fetch(`${this.baseUrl(apiUrl)}/v2/image/generate/ideogram-3?dry_run=true`, {
        method: "POST",
        headers: { "Api-Key": apiKey },
        body: form,
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
