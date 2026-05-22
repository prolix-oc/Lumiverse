import { decodeMulti } from "@msgpack/msgpack";
import sharp from "../../utils/sharp-config";
import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { applyRawOverride } from "../types";

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
    },
    apiKeyRequired: true,
    modelListStyle: "static",
    staticModels: [
      { id: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 (Full)" },
      { id: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 (Curated)" },
      { id: "nai-diffusion-4-full", label: "NAI Diffusion V4 (Full)" },
      { id: "nai-diffusion-4-curated-preview", label: "NAI Diffusion V4 (Curated)" },
      { id: "nai-diffusion-3", label: "NAI Diffusion Anime V3" },
      { id: "nai-diffusion-furry-3", label: "NAI Diffusion Furry V3" },
    ],
    defaultUrl: "https://image.novelai.net",
  };

  async generate(apiKey: string, _apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const params = request.parameters;
    const model = request.model || "nai-diffusion-4-5-full";
    const [width, height] = String(params.resolution || "1216x832").split("x").map(Number);
    const negativePrompt =
      params.negativePrompt ||
      "lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, blurry, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, text, watermark, username, logo, signature, dithering, halftone, screentone, scan artifacts, multiple views, blank page";
    const seed = params.seed ?? Math.floor(Math.random() * 2147483647);
    const isV4 = isNovelAIV4Model(model);

    const naiParams: any = {
      params_version: 3,
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
      stream: "msgpack",
    };

    // Character tags from scene analysis (passed through parameters)
    const charTags: Array<{ tags: string }> = params.characterTags || [];

    if (isV4) {
      naiParams.autoSmea = params.smea ?? false;
      naiParams.characterPrompts = charTags.map((char) => ({
        prompt: char.tags,
        uc: negativePrompt,
        center: { x: 0, y: 0 },
        enabled: true,
      }));
      naiParams.v4_prompt = {
        caption: {
          base_caption: request.prompt,
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

    // Director reference images (pre-resolved by orchestrator)
    const directorImages: Array<{
      data: string;
      strength: number;
      infoExtracted: number;
      refType: string;
    }> = params.resolvedReferenceImages || [];

    if (directorImages.length > 0) {
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
    const outerBody = { input: request.prompt, model, action: "generate", parameters: naiParams };
    const finalBody = applyRawOverride(outerBody, params.rawRequestOverride);

    const res = await fetch("https://image.novelai.net/ai/generate-image-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(`NovelAI API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);
    }

    const imageDataUrl = await extractImageFromResponse(res);
    return { imageDataUrl, model, provider: this.name };
  }

  async validateKey(apiKey: string, _apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch("https://api.novelai.net/user/information", {
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

// --- Helper functions extracted from image-gen.service.ts ---

function isNovelAIV4Model(model: string): boolean {
  return model.startsWith("nai-diffusion-4");
}

async function extractImageFromResponse(res: Response): Promise<string> {
  let fullBuffer: Uint8Array;
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        chunks.push(value);
        totalBytes += value.length;
      }
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

  const primaryBuffer = fullBuffer.buffer.slice(
    fullBuffer.byteOffset,
    fullBuffer.byteOffset + fullBuffer.byteLength
  ) as ArrayBuffer;

  // Strategy 1: Direct PNG scan
  let imageBytes = extractPngFromBuffer(primaryBuffer);
  if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;

  // Strategy 2: ZIP archive scan
  const pkIndex = findBytes(fullBuffer, [0x50, 0x4b, 0x03, 0x04]);
  if (pkIndex !== -1) {
    const zipSlice = fullBuffer.slice(pkIndex);
    const zipBuffer = zipSlice.buffer.slice(
      zipSlice.byteOffset,
      zipSlice.byteOffset + zipSlice.byteLength
    ) as ArrayBuffer;
    imageBytes = extractPngFromBuffer(zipBuffer);
    if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;
  }

  // Strategy 3: MessagePack decode
  let largestBinary: Uint8Array | null = null;
  let largestSize = 0;
  try {
    for (const obj of decodeMulti(fullBuffer)) {
      if (obj instanceof Uint8Array && obj.length > largestSize) {
        largestBinary = obj;
        largestSize = obj.length;
      } else if (obj && typeof obj === "object") {
        for (const val of Object.values(obj as Record<string, unknown>)) {
          if (val instanceof Uint8Array && val.length > largestSize) {
            largestBinary = val;
            largestSize = val.length;
          }
        }
      }
    }
  } catch {
    // fallthrough
  }

  if (largestBinary) return `data:image/png;base64,${uint8ToBase64(largestBinary)}`;
  throw new Error(`Could not extract image from ${fullBuffer.length} byte NovelAI response`);
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

function findBytes(haystack: Uint8Array, needle: number[]): number {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((b, j) => haystack[i + j] === b)) return i;
  }
  return -1;
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
