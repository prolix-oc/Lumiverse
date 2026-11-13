import { unzipSync } from "fflate";
import { decodeMulti } from "@msgpack/msgpack";
import sharp from "../../utils/sharp-config";
import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { cancelStreamAndCloseConnection, fetchWithPreflightAbort, readWithAbort } from "../../llm/stream-utils";
import { applyRawOverride } from "../types";

// NovelAI expects an unsigned 64-bit seed, so -1 (the "random" sentinel used by other
// providers and by saved connection defaults) must never reach the wire. Connection
// defaults are merged into the request after extension-side normalization, so resolve
// the seed once more at the final request boundary.
function resolveNovelAISeed(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return Math.floor(Math.random() * 2147483647);
}

const DIRECTOR_REF_CANVASES: Array<[number, number]> = [
  [1024, 1536],
  [1536, 1024],
  [1472, 1472],
];

export class NovelAIImageProvider implements ImageProvider {
  readonly name = "novelai";
  readonly displayName = "NovelAI";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      sampler: {
        type: "select",
        default: "k_euler_ancestral",
        description: "Diffusion sampler algorithm",
        options: [
          { id: "k_euler_ancestral", label: "Euler Ancestral" },
          { id: "k_euler", label: "Euler" },
          { id: "k_dpmpp_2m", label: "DPM++ 2M" },
          { id: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral" },
          { id: "k_dpmpp_sde", label: "DPM++ SDE" },
          { id: "ddim_v3", label: "DDIM" },
        ],
      },
      resolution: {
        type: "select",
        default: "1216x832",
        description: "Output image resolution",
        options: [
          { id: "832x1216", label: "832x1216 (Portrait)" },
          { id: "1216x832", label: "1216x832 (Landscape)" },
          { id: "1024x1024", label: "1024x1024 (Square)" },
          { id: "512x768", label: "512x768 (Small Portrait)" },
          { id: "768x512", label: "768x512 (Small Landscape)" },
          { id: "640x640", label: "640x640 (Small Square)" },
          { id: "1024x1536", label: "1024x1536 (Large Portrait)" },
          { id: "1536x1024", label: "1536x1024 (Large Landscape)" },
          { id: "1088x1920", label: "1088x1920 (Wallpaper Portrait)" },
          { id: "1920x1088", label: "1920x1088 (Wallpaper Landscape)" },
        ],
      },
      steps: {
        type: "integer",
        default: 28,
        min: 1,
        max: 50,
        description: "Number of diffusion sampling steps",
      },
      guidance: {
        type: "number",
        default: 5,
        min: 1,
        max: 20,
        step: 0.5,
        description: "Classifier-free guidance scale",
      },
      negativePrompt: {
        type: "string",
        default: "lowres, bad anatomy, blurry, text, watermark, error, worst quality",
        description: "Negative prompt (undesired content)",
        group: "advanced",
      },
      smea: {
        type: "boolean",
        default: false,
        description: "Symmetric Multistep Eta Acceleration (V3: SMEA, V4: autoSmea)",
        group: "advanced",
      },
      smeaDyn: {
        type: "boolean",
        default: false,
        description: "SMEA with dynamic thresholds (V3 only)",
        group: "advanced",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducibility (leave empty for random)",
        group: "advanced",
      },
      v5Mode: {
        type: "select",
        default: "anime",
        description: "V5 dataset mode. Furry mode adds NovelAI's fur dataset tag to the base prompt.",
        options: [
          { id: "anime", label: "Anime" },
          { id: "furry", label: "Furry" },
        ],
        modelPrefixes: ["nai-diffusion-5"],
      },
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 (Full)" },
      { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 (Curated)" },
      { id: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 (Full)" },
      { id: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 (Curated)" },
      { id: "nai-diffusion-4-full", label: "NAI Diffusion V4 (Full)" },
      { id: "nai-diffusion-4-curated-preview", label: "NAI Diffusion V4 (Curated)" },
      { id: "nai-diffusion-3", label: "NAI Diffusion Anime V3" },
      { id: "nai-diffusion-furry-3", label: "NAI Diffusion Furry V3" },
    ],
    defaultUrl: "https://image.novelai.net",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const nonStreaming = request.connectionOptions?.novelai?.nonStreaming === true;
    const params = request.parameters;
    const model = request.model || "nai-diffusion-4-5-full";
    const [width, height] = String(params.resolution || "1216x832").split("x").map(Number);
    const negativePrompt =
      params.negativePrompt ||
      "lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, blurry, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, text, watermark, username, logo, signature, dithering, halftone, screentone, scan artifacts, multiple views, blank page";
    const seed = resolveNovelAISeed(params.seed);
    const isV5 = isNovelAIV5Model(model);
    const prompt = applyNovelAIV5Mode(request.prompt, isV5 ? params.v5Mode : undefined);
    const usesStructuredPrompts = isNovelAIV4OrLaterModel(model);

    const naiParams: any = {
      params_version: isV5 ? 4 : 3,
      width,
      height,
      scale: params.guidance ?? 5,
      sampler: params.sampler || "k_euler_ancestral",
      steps: params.steps ?? 28,
      n_samples: 1,
      seed,
      ucPreset: 0,
      qualityToggle: true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      cfg_rescale: 0,
      noise_schedule: "karras",
      legacy_v3_extend: false,
      skip_cfg_above_sigma: null,
      use_coords: false,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      inpaintImg2ImgStrength: 1,
      negative_prompt: negativePrompt,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      image_format: "png",
    };

    // Character tags from scene analysis (passed through parameters)
    const charTags: Array<{ tags: string }> = params.characterTags || [];

    if (usesStructuredPrompts) {
      naiParams.autoSmea = params.smea ?? false;
      if (isV5) {
        // V5 still uses v4_prompt, but the current client mirrors its base
        // prompt into the flat prompt field as well.
        naiParams.prompt = prompt;
        naiParams.extra_noise_seed = seed;
      }
      naiParams.characterPrompts = charTags.map((char) => ({
        prompt: char.tags,
        uc: negativePrompt,
        center: { x: 0, y: 0 },
        enabled: true,
      }));
      naiParams.v4_prompt = {
        caption: {
          base_caption: prompt,
          char_captions: charTags.map((char) => ({
            char_caption: char.tags,
            centers: [{ x: 0, y: 0 }],
          })),
        },
        use_coords: false,
        use_order: true,
      };
      naiParams.v4_negative_prompt = {
        caption: {
          base_caption: negativePrompt,
          char_captions: charTags.map(() => ({
            char_caption: negativePrompt,
            centers: [{ x: 0, y: 0 }],
          })),
        },
        legacy_uc: false,
      };
    } else {
      naiParams.sm = params.smea ?? false;
      naiParams.sm_dyn = params.smeaDyn ?? false;
    }

    // Precise Reference is a V4.5 feature. NovelAI V5 does not support either
    // Precise Reference or Vibe Transfer yet, so never leak V4.5's padded
    // director_reference_* shape into a V5 request.
    const directorImages: Array<{
      data: string;
      strength: number;
      infoExtracted: number;
      refType: string;
    }> = params.resolvedReferenceImages || [];

    if (directorImages.length > 0 && !isV5) {
      const fidelity = params.referenceFidelity ?? 1;
      const paddedImages: string[] = [];
      for (const ref of directorImages) {
        try {
          paddedImages.push(await padDirectorRefImage(ref.data));
        } catch {
          paddedImages.push(ref.data);
        }
      }
      naiParams.director_reference_images = paddedImages;
      naiParams.director_reference_strength_values = directorImages.map((r) => r.strength ?? 0.5);
      naiParams.director_reference_secondary_strength_values = directorImages.map(() => 1 - fidelity);
      naiParams.director_reference_information_extracted = directorImages.map(() => 1.0);
      naiParams.director_reference_descriptions = directorImages.map((r) => ({
        caption: { base_caption: r.refType || "character&style", char_captions: [] },
        legacy_uc: false,
      }));
    }

    // Apply raw request override (power-user escape hatch) — merges at outer body level,
    // so users can override both the envelope (input, model, action) and inner parameters
    const outerBody = { input: prompt, model, action: "generate", parameters: naiParams };
    const finalBody = applyRawOverride(outerBody, params.rawRequestOverride);

    // The saved connection controls transport, including when raw parameters are supplied.
    if (finalBody.parameters && typeof finalBody.parameters === "object") {
      // Raw overrides and merged connection defaults can reintroduce an invalid seed.
      finalBody.parameters.seed = resolveNovelAISeed(finalBody.parameters.seed);
      if (nonStreaming) delete finalBody.parameters.stream;
      else finalBody.parameters.stream = "msgpack";
    }
    const route = nonStreaming ? "/ai/generate-image" : "/ai/generate-image-stream";
    const endpoint = `${this.baseUrl(apiUrl)}${route}`;
    const res = await fetchWithPreflightAbort(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(finalBody),
    }, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const imageDataUrl = await extractImageFromResponse(res, request.signal);
    return { imageDataUrl, model, provider: this.name };
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      // Validate against the Image API itself. NovelAI documents this as an
      // authenticated, non-generation endpoint and accepts persistent API
      // tokens here; the Primary API is not the service this provider uses.
      const res = await fetch(`${this.baseUrl(apiUrl)}/user/information`, {
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

  private baseUrl(apiUrl: string): string {
    return (apiUrl.trim() || this.capabilities.defaultUrl).replace(/\/+$/, "");
  }
}

// --- Helper functions extracted from image-gen.service.ts ---

function isNovelAIV4OrLaterModel(model: string): boolean {
  return model.startsWith("nai-diffusion-4") || model.startsWith("nai-diffusion-5");
}

function isNovelAIV5Model(model: string): boolean {
  return model.startsWith("nai-diffusion-5");
}

/**
 * NovelAI's Anime/Furry switch is a prompt transform, not an Image API field.
 * Match the first-party client by leaving Anime prompts alone and adding the
 * dataset tag only when Furry mode is selected and no dataset tag leads the
 * prompt already.
 */
function applyNovelAIV5Mode(prompt: string, mode: unknown): string {
  if (mode !== "furry") return prompt;
  const leadingPrompt = prompt.trimStart().toLowerCase();
  if (leadingPrompt.startsWith("fur dataset") || leadingPrompt.startsWith("background dataset")) {
    return prompt;
  }
  return prompt ? `fur dataset, ${prompt}` : "fur dataset";
}

// Sanity ceiling on the streamed image payload so a misbehaving upstream can't
// grow the buffer without bound. NovelAI images are a few MB; 64 MB is generous.
const NOVELAI_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

async function extractImageFromResponse(res: Response, signal?: AbortSignal): Promise<string> {
  let fullBuffer: Uint8Array;
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    // Drive the reader through readWithAbort (user-space cancel) rather than
    // handing the signal to Bun's fetch — cancelling a streaming body mid-read
    // via the fetch signal can crash Bun's HTTPThread. cancel() is awaited so
    // the socket is torn down before the Response is dropped.
    let doneNaturally = false;
    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, signal);
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (done) { doneNaturally = true; break; }
        if (value?.length) {
          totalBytes += value.length;
          if (totalBytes > NOVELAI_MAX_IMAGE_BYTES) {
            throw new Error(`NovelAI image stream exceeded ${NOVELAI_MAX_IMAGE_BYTES} bytes`);
          }
          chunks.push(value);
        }
      }
    } finally {
      if (!doneNaturally) await cancelStreamAndCloseConnection(reader, res);
    }
    fullBuffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      fullBuffer.set(c, offset);
      offset += c.length;
    }
  } else {
    fullBuffer = new Uint8Array(await res.arrayBuffer());
  }

  // Decode archives before scanning for PNG signatures: DEFLATE stored blocks
  // can contain PNG bytes interrupted by block headers that are not image data.
  if (fullBuffer[0] === 0x50 && fullBuffer[1] === 0x4b && fullBuffer[2] === 0x03 && fullBuffer[3] === 0x04) {
    let selectedImage = false;
    const images = unzipSync(fullBuffer, {
      filter: (file) => {
        if (selectedImage || !/\.png$/i.test(file.name) || file.originalSize > NOVELAI_MAX_IMAGE_BYTES) return false;
        selectedImage = true;
        return true;
      },
    });
    for (const bytes of Object.values(images)) {
      const imageBytes = extractPngFromBuffer(bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);
      if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;
    }
    throw new Error("NovelAI ZIP response did not contain a supported PNG image");
  }

  const primaryBuffer = fullBuffer.buffer.slice(
    fullBuffer.byteOffset,
    fullBuffer.byteOffset + fullBuffer.byteLength
  ) as ArrayBuffer;
  const imageBytes = extractPngFromBuffer(primaryBuffer);
  if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;

  // Streaming endpoints can return a sequence of MessagePack events.
  let largestBinary: Uint8Array | null = null;
  let largestSize = 0;
  let streamError: string | null = null;
  try {
    for (const obj of decodeMulti(fullBuffer)) {
      streamError ??= findNovelAIStreamError(obj);
      const binary = findLargestBinary(obj);
      if (binary && binary.length > largestSize) {
        largestBinary = binary;
        largestSize = binary.length;
      }
    }
  } catch {
    // fallthrough
  }

  // NovelAI can report generation failures as a small MessagePack event while
  // keeping the HTTP response at 200. Surface that upstream message instead of
  // misreporting the event bytes as an unextractable image.
  if (streamError) {
    throw new ProviderRequestError({
      provider: "NovelAI",
      operation: "image generate",
      detail: streamError,
      retryable: false,
    });
  }

  if (largestBinary) return `data:image/png;base64,${uint8ToBase64(largestBinary)}`;
  throw new Error(`Could not extract image from ${fullBuffer.length} byte NovelAI response`);
}

function findLargestBinary(value: unknown, depth = 0): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (!value || typeof value !== "object" || depth >= 4) return null;

  let largest: Uint8Array | null = null;
  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of values) {
    const candidate = findLargestBinary(child, depth + 1);
    if (candidate && (!largest || candidate.length > largest.length)) largest = candidate;
  }
  return largest;
}

function findNovelAIStreamError(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth >= 4) return null;
  const record = value as Record<string, unknown>;
  const eventType = String(record.event_type ?? record.type ?? record.status ?? "").toLowerCase();
  const isErrorEvent = eventType === "error" || eventType === "failed" || eventType === "failure";

  const directError = readableErrorValue(record.error);
  if (directError) return directError;

  if (isErrorEvent) {
    for (const field of [record.message, record.detail, record.data]) {
      const detail = readableErrorValue(field);
      if (detail) return detail;
    }
    return "NovelAI returned an error event without a message";
  }

  for (const field of [record.data, record.event]) {
    const nested = findNovelAIStreamError(field, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function readableErrorValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1000);
  if (value instanceof Uint8Array) {
    const decoded = new TextDecoder().decode(value).trim();
    return decoded ? decoded.slice(0, 1000) : null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const field of [record.message, record.detail, record.error]) {
    const nested = readableErrorValue(field);
    if (nested) return nested;
  }
  return null;
}

function extractPngFromBuffer(buffer: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buffer);
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const IEND_CRC = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  let start = -1;
  for (let i = 0; i <= bytes.length - 8; i++) {
    if (PNG_SIG.every((b, j) => bytes[i + j] === b)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 8; i <= bytes.length - 8; i++) {
    if (IEND_CRC.every((b, j) => bytes[i + j] === b)) {
      end = i + 8;
      break;
    }
  }
  if (end === -1) return null;
  return bytes.slice(start, end);
}

async function padDirectorRefImage(base64Data: string): Promise<string> {
  const src = base64ToUint8(base64Data);
  const meta = await sharp(src).metadata();
  const srcAr = (meta.width || 1) / (meta.height || 1);

  let best = DIRECTOR_REF_CANVASES[0];
  let bestDiff = Infinity;
  for (const [cw, ch] of DIRECTOR_REF_CANVASES) {
    const diff = Math.abs(srcAr - cw / ch);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [cw, ch];
    }
  }

  const [canvasW, canvasH] = best;
  const out = await sharp(src)
    .resize(canvasW, canvasH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toBuffer();
  return out.toString("base64");
}

function base64ToUint8(base64: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "=") break;
    const idx = chars.indexOf(c);
    if (idx === -1) continue;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }

  return new Uint8Array(out);
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;

  while (i < bytes.length) {
    const a = bytes[i++] || 0;
    const b = bytes[i++] || 0;
    const c = bytes[i++] || 0;

    const triplet = (a << 16) | (b << 8) | c;
    out += chars[(triplet >> 18) & 0x3f];
    out += chars[(triplet >> 12) & 0x3f];
    out += i - 2 > bytes.length ? "=" : chars[(triplet >> 6) & 0x3f];
    out += i - 1 > bytes.length ? "=" : chars[triplet & 0x3f];
  }

  const mod = bytes.length % 3;
  if (mod > 0) out = out.slice(0, mod === 1 ? -2 : -1) + (mod === 1 ? "==" : "=");
  return out;
}
