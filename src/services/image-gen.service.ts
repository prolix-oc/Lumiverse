import { decodeMulti } from "@msgpack/msgpack";
import sharp from "sharp";
import { BUILTIN_TOOLS_MAP } from "./council/builtin-tools";
import * as councilSettingsSvc from "./council/council-settings.service";
import { getSidecarSettings } from "./sidecar-settings.service";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as imagesSvc from "./images.service";
import * as connectionsSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { connectionSecretKey } from "./connections.service";
import { rawGenerate } from "./generate.service";
import type { LlmMessage } from "../llm/types";

const IMAGE_SETTINGS_KEY = "imageGeneration";

const DEFAULT_IMAGE_SETTINGS: ImageGenSettings = {
  enabled: false,
  provider: "google_gemini",
  includeCharacters: false,
  google: {
    model: "gemini-3.1-flash-image",
    aspectRatio: "16:9",
    imageSize: "1K",
    connectionProfileId: null,
    referenceImages: [],
  },
  nanogpt: {
    model: "hidream",
    size: "1024x1024",
    apiKey: "",
    referenceImages: [],
    strength: 0.8,
    guidanceScale: 7.5,
    numInferenceSteps: 30,
    seed: null,
  },
  novelai: {
    apiKey: "",
    model: "nai-diffusion-4-5-full",
    sampler: "k_euler_ancestral",
    resolution: "1216x832",
    steps: 28,
    guidance: 5,
    negativePrompt: "lowres, bad anatomy, blurry, text, watermark, error, worst quality",
    smea: false,
    smeaDyn: false,
    seed: null,
    referenceImages: [],
    includeCharacterAvatar: false,
    includePersonaAvatar: false,
    referenceStrength: 0.5,
    referenceInfoExtracted: 1,
    referenceFidelity: 1,
    referenceType: "character&style",
    avatarReferenceType: "character",
  },
  sceneChangeThreshold: 2,
  autoGenerate: true,
  forceGeneration: false,
  backgroundOpacity: 0.35,
  fadeTransitionMs: 800,
};

const sceneCache = new Map<string, SceneData>();
const SCENE_FIELDS: Array<keyof SceneData> = ["environment", "time_of_day", "weather", "mood", "focal_detail"];
const DIRECTOR_REF_CANVASES: Array<[number, number]> = [[1024, 1536], [1536, 1024], [1472, 1472]];

export interface SceneData {
  environment: string;
  time_of_day: string;
  weather: string;
  mood: string;
  focal_detail: string;
  palette_override?: string;
  scene_changed: boolean;
}

interface GoogleSettings {
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  connectionProfileId?: string | null;
  referenceImages?: Array<{ data: string; mimeType?: string }>;
}

interface NanoGptSettings {
  apiKey?: string;
  model?: string;
  size?: string;
  referenceImages?: Array<{ data: string; mimeType?: string }>;
  strength?: number;
  guidanceScale?: number;
  numInferenceSteps?: number;
  seed?: number | null;
}

interface NovelAiSettings {
  apiKey?: string;
  model?: string;
  sampler?: string;
  resolution?: string;
  steps?: number;
  guidance?: number;
  negativePrompt?: string;
  smea?: boolean;
  smeaDyn?: boolean;
  seed?: number | null;
  referenceImages?: Array<{ data: string; mimeType?: string }>;
  includeCharacterAvatar?: boolean;
  includePersonaAvatar?: boolean;
  referenceStrength?: number;
  referenceInfoExtracted?: number;
  referenceFidelity?: number;
  referenceType?: "character" | "style" | "character&style";
  avatarReferenceType?: "character" | "style" | "character&style";
}

interface ImageGenSettings {
  enabled: boolean;
  provider: string;
  includeCharacters: boolean;
  google: GoogleSettings;
  nanogpt: NanoGptSettings;
  novelai: NovelAiSettings;
  sceneChangeThreshold: number;
  autoGenerate: boolean;
  forceGeneration: boolean;
  backgroundOpacity: number;
  fadeTransitionMs: number;
}

export interface ImageGenResult {
  generated: boolean;
  reason?: string;
  scene: SceneData;
  prompt: string;
  provider: string;
  imageDataUrl?: string;
}

export function getImageProviders() {
  return {
    providers: [
      {
        id: "google_gemini",
        name: "Google Gemini",
        models: [
          { id: "gemini-3.1-flash-image", label: "Nano Banana 2 (Flash)" },
          { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro" },
        ],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
      {
        id: "nanogpt",
        name: "Nano-GPT",
        models: [
          { id: "hidream", label: "HiDream" },
          { id: "hidream_fast", label: "HiDream Fast" },
          { id: "hidream_dev", label: "HiDream Dev" },
          { id: "hidream_full", label: "HiDream Full" },
          { id: "flux-pro", label: "Flux Pro" },
          { id: "flux_pro_ultra", label: "Flux Pro Ultra" },
          { id: "flux-kontext", label: "Flux Kontext" },
          { id: "flux_schnell", label: "Flux Schnell" },
          { id: "dall-e-3", label: "DALL-E 3" },
          { id: "gpt_image_1", label: "GPT Image 1" },
          { id: "imagen4_preview", label: "Imagen 4 Preview" },
          { id: "midjourney", label: "Midjourney" },
          { id: "recraft", label: "Recraft" },
          { id: "sdxl", label: "SDXL" },
          { id: "sd35_large", label: "SD 3.5 Large" },
          { id: "reve-v1", label: "Reve v1" },
        ],
        sizes: ["256x256", "512x512", "1024x1024"],
      },
      {
        id: "novelai",
        name: "NovelAI",
        models: [
          { id: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 (Full)" },
          { id: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 (Curated)" },
          { id: "nai-diffusion-4-full", label: "NAI Diffusion V4 (Full)" },
          { id: "nai-diffusion-4-curated-preview", label: "NAI Diffusion V4 (Curated)" },
          { id: "nai-diffusion-3", label: "NAI Diffusion Anime V3" },
          { id: "nai-diffusion-furry-3", label: "NAI Diffusion Furry V3" },
        ],
        samplers: [
          { id: "k_euler_ancestral", label: "Euler Ancestral" },
          { id: "k_euler", label: "Euler" },
          { id: "k_dpmpp_2m", label: "DPM++ 2M" },
          { id: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral" },
          { id: "k_dpmpp_sde", label: "DPM++ SDE" },
          { id: "ddim_v3", label: "DDIM" },
        ],
        resolutions: [
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
    ],
  };
}

export async function fetchNanoGptModels(apiKey: string): Promise<{ models: Array<{ id: string; label: string }> }> {
  const res = await fetch("https://nano-gpt.com/api/v1/image-models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error");
    throw new Error(`Nano-GPT API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const modelList = Array.isArray(data) ? data : data.data || data.models || [];
  return {
    models: modelList.map((m: any) => ({
      id: m.id || m.model || String(m),
      label: m.name || m.label || m.id || m.model || String(m),
    })),
  };
}

export async function generateSceneBackground(
  userId: string,
  chatId: string,
  opts?: { forceGeneration?: boolean }
): Promise<ImageGenResult> {
  const settings = getImageGenSettings(userId);
  const scene = await analyzeScene(userId, chatId);

  const cacheKey = `${userId}:${chatId}`;
  const previous = sceneCache.get(cacheKey) || null;
  const threshold = Math.max(1, Number(settings.sceneChangeThreshold || 2));
  const force = !!opts?.forceGeneration || !!settings.forceGeneration;

  if (!force && previous && !hasSceneChanged(scene, previous, threshold)) {
    return {
      generated: false,
      reason: "Scene has not changed enough",
      scene,
      prompt: buildImagePrompt(scene, settings, settings.provider, settings.includeCharacters),
      provider: settings.provider,
    };
  }

  const provider = settings.provider || "google_gemini";
  const prompt = buildImagePrompt(scene, settings, provider, settings.includeCharacters);
  let imageDataUrl: string;

  if (provider === "google_gemini") {
    imageDataUrl = await generateWithGemini(userId, settings, prompt);
  } else if (provider === "nanogpt") {
    imageDataUrl = await generateWithNanoGpt(settings, prompt);
  } else if (provider === "novelai") {
    imageDataUrl = await generateWithNovelAi(userId, chatId, settings, prompt, scene, settings.includeCharacters);
  } else {
    throw new Error(`Unsupported image provider: ${provider}`);
  }

  sceneCache.set(cacheKey, scene);
  return { generated: true, scene, prompt, provider, imageDataUrl };
}

function getImageGenSettings(userId: string): ImageGenSettings {
  const row = settingsSvc.getSetting(userId, IMAGE_SETTINGS_KEY);
  return {
    ...DEFAULT_IMAGE_SETTINGS,
    ...(row?.value || {}),
    google: { ...DEFAULT_IMAGE_SETTINGS.google, ...(row?.value?.google || {}) },
    nanogpt: { ...DEFAULT_IMAGE_SETTINGS.nanogpt, ...(row?.value?.nanogpt || {}) },
    novelai: { ...DEFAULT_IMAGE_SETTINGS.novelai, ...(row?.value?.novelai || {}) },
  };
}

async function analyzeScene(userId: string, chatId: string): Promise<SceneData> {
  const sidecar = getSidecarSettings(userId);
  if (!sidecar.connectionProfileId || !sidecar.model) {
    throw new Error("Sidecar LLM connection is required for scene analysis — configure it in the Council panel");
  }
  const conn = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const tool = BUILTIN_TOOLS_MAP.get("generate_scene");
  if (!tool) throw new Error("generate_scene council tool is unavailable");

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages: [
      { role: "system", content: `${tool.prompt}\n\nYou must return ONLY valid JSON with the exact schema keys and no markdown fences.` },
      ...buildContextMessages(userId, chatId),
      { role: "user", content: "Return scene JSON now." },
    ],
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens,
    },
  });

  return parseSceneJson(response.content || "");
}

function buildContextMessages(userId: string, chatId: string): LlmMessage[] {
  const msgs: LlmMessage[] = [];
  const chat = chatsSvc.getChat(userId, chatId);
  if (chat) {
    const char = charactersSvc.getCharacter(userId, chat.character_id);
    if (char) {
      const charInfo = [char.name && `Name: ${char.name}`, char.description && `Description: ${char.description}`, char.scenario && `Scenario: ${char.scenario}`].filter(Boolean).join("\n");
      if (charInfo) msgs.push({ role: "system", content: `## Character Information\n${charInfo}` });
    }
  }
  for (const m of chatsSvc.getMessages(userId, chatId).slice(-24)) {
    msgs.push({ role: m.is_user ? "user" : "assistant", content: m.content });
  }
  return msgs;
}

function parseSceneJson(input: string): SceneData {
  const cleaned = input.trim();
  const fromFence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fromFence?.[1] || cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = JSON.parse(candidate.slice(start, end + 1));
    else throw new Error("Could not parse scene JSON from council response");
  }
  return {
    environment: String(parsed.environment || "A neutral establishing shot"),
    time_of_day: String(parsed.time_of_day || "night"),
    weather: String(parsed.weather || "clear"),
    mood: String(parsed.mood || "neutral"),
    focal_detail: String(parsed.focal_detail || "the central environment"),
    palette_override: parsed.palette_override ? String(parsed.palette_override) : undefined,
    scene_changed: Boolean(parsed.scene_changed),
  };
}

function normalizeField(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

function hasSceneChanged(next: SceneData, prev: SceneData, threshold: number): boolean {
  let changed = 0;
  for (const key of SCENE_FIELDS) {
    if (normalizeField(next[key]) !== normalizeField(prev[key])) changed++;
  }
  return changed >= threshold;
}

function buildImagePrompt(scene: SceneData, settings: ImageGenSettings, provider: string, includeCharacters: boolean): string {
  if (provider === "novelai") {
    const tags: string[] = ["illustration", "anime coloring"];

    const compositionRating = Array.isArray((scene as any).composition_rating) ? (scene as any).composition_rating : null;
    if (includeCharacters && compositionRating?.length) tags.push(...compositionRating.map((v: any) => String(v)));
    if (includeCharacters && (scene as any).composition_subjects) tags.push(String((scene as any).composition_subjects));
    if (includeCharacters && (scene as any).composition_shot) tags.push(String((scene as any).composition_shot));
    if (includeCharacters && (scene as any).composition_camera) tags.push(String((scene as any).composition_camera));

    if (scene.environment) tags.push(scene.environment);
    if (scene.time_of_day) tags.push(scene.time_of_day);
    if (scene.weather && scene.weather !== "clear") tags.push(scene.weather);
    if (scene.mood) tags.push(scene.mood);
    if (scene.focal_detail) tags.push(scene.focal_detail);
    if (scene.palette_override) tags.push(scene.palette_override);

    if (includeCharacters) {
      const names = String((scene as any).character_names || "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
      tags.push(...names);
      if (Array.isArray((scene as any).character_appearances)) {
        for (const c of (scene as any).character_appearances) if (c?.tags) tags.push(String(c.tags));
      }
    } else {
      tags.push("no humans", "scenery", "background", "detailed background");
    }

    tags.push("detailed", "depth of field");
    return tags.join(", ");
  }

  let prompt = "";
  if (provider !== "nanogpt") {
    const ar = settings.google?.aspectRatio || "16:9";
    const res = settings.google?.imageSize || "1K";
    prompt += `Generate a ${ar} aspect ratio image at ${res} resolution.\n`;
  }
  prompt += `${scene.environment || "A neutral setting"}`;
  if (scene.time_of_day) prompt += ` during ${scene.time_of_day}`;
  prompt += ".";
  if (scene.weather) prompt += ` Weather: ${scene.weather}.`;
  if (scene.mood) prompt += ` Mood: ${scene.mood}.`;
  if (scene.focal_detail) prompt += ` Focus: ${scene.focal_detail}.`;
  if (scene.palette_override) prompt += ` Colors: ${scene.palette_override}.`;
  if (!includeCharacters) {
    prompt += "\nThis is a background/environment image ONLY. Do NOT include any people, characters, or humanoid figures in the image.";
  }
  prompt += "\nStyle: anime, detailed, high quality, vibrant colors.";
  return prompt;
}

async function generateWithGemini(userId: string, settings: ImageGenSettings, prompt: string): Promise<string> {
  const google = settings.google || {};
  const model = google.model || "gemini-3.1-flash-image";
  const profileId = google.connectionProfileId;
  if (!profileId) throw new Error("Google Gemini image generation requires a connection profile");

  const conn = connectionsSvc.getConnection(userId, profileId);
  if (!conn) throw new Error("Google connection profile not found");
  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(profileId));
  if (!apiKey) throw new Error("No API key on selected Google connection profile");

  const base = (conn.api_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const endpoint = base.includes(":generateContent") ? base : `${base}/models/${model}:generateContent`;
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 1,
      topP: 0.95,
    },
  };
  if (google.aspectRatio) body.generationConfig.imageGenerationConfig = { aspectRatio: google.aspectRatio };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p: any) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("Gemini returned no image data");
  return `data:${inline.mimeType || "image/png"};base64,${inline.data}`;
}

async function generateWithNanoGpt(settings: ImageGenSettings, prompt: string): Promise<string> {
  const nano = settings.nanogpt || {};
  if (!nano.apiKey) throw new Error("Nano-GPT API key is required");

  const requestBody: any = {
    model: nano.model || "hidream",
    prompt,
    n: 1,
    size: nano.size || "1024x1024",
    response_format: "b64_json",
  };

  if (Array.isArray(nano.referenceImages) && nano.referenceImages.length > 0) {
    requestBody.imageDataUrls = nano.referenceImages.filter((r) => !!r.data).map((r) => `data:${r.mimeType || "image/png"};base64,${r.data}`);
    if (nano.strength != null) requestBody.strength = nano.strength;
    if (nano.guidanceScale != null) requestBody.guidance_scale = nano.guidanceScale;
    if (nano.numInferenceSteps != null) requestBody.num_inference_steps = nano.numInferenceSteps;
    if (nano.seed != null) requestBody.seed = nano.seed;
  }

  const res = await fetch("https://nano-gpt.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${nano.apiKey}` },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) throw new Error(`Nano-GPT API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Nano-GPT returned no image data");
  return `data:image/png;base64,${b64}`;
}

function isNovelAIV4Model(model: string): boolean {
  return model.startsWith("nai-diffusion-4");
}

function extractPngFromBuffer(buffer: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buffer);
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const IEND_CRC = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  let start = -1;
  for (let i = 0; i <= bytes.length - 8; i++) if (PNG_SIG.every((b, j) => bytes[i + j] === b)) { start = i; break; }
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 8; i <= bytes.length - 8; i++) if (IEND_CRC.every((b, j) => bytes[i + j] === b)) { end = i + 8; break; }
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

async function gatherDirectorImages(userId: string, chatId: string, naiSettings: NovelAiSettings) {
  const images: Array<{ data: string; strength: number; infoExtracted: number; refType: string }> = [];
  const strength = naiSettings.referenceStrength ?? 0.5;
  const infoExtracted = naiSettings.referenceInfoExtracted ?? 1;
  const manualRefType = naiSettings.referenceType || "character&style";
  const avatarRefType = naiSettings.avatarReferenceType || "character";

  for (const ref of naiSettings.referenceImages || []) {
    if (ref?.data) images.push({ data: ref.data, strength, infoExtracted, refType: manualRefType });
  }

  if (naiSettings.includeCharacterAvatar) {
    const chat = chatsSvc.getChat(userId, chatId);
    if (chat) {
      const character = charactersSvc.getCharacter(userId, chat.character_id);
      if (character?.image_id) {
        const path = imagesSvc.getImageFilePath(userId, character.image_id, false);
        if (path) {
          const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
          images.push({ data: uint8ToBase64(bytes), strength, infoExtracted, refType: avatarRefType });
        }
      }
    }
  }

  if (naiSettings.includePersonaAvatar) {
    const personas = personasSvc.listPersonas(userId, { limit: 100, offset: 0 }).data;
    const persona = personas.find((p) => p.is_default) || personas[0];
    if (persona?.image_id) {
      const path = imagesSvc.getImageFilePath(userId, persona.image_id, false);
      if (path) {
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
        images.push({ data: uint8ToBase64(bytes), strength, infoExtracted, refType: avatarRefType });
      }
    }
  }

  return images;
}

async function generateWithNovelAi(
  userId: string,
  chatId: string,
  settings: ImageGenSettings,
  prompt: string,
  scene: SceneData,
  includeCharacters: boolean
): Promise<string> {
  const nai = settings.novelai || {};
  if (!nai.apiKey) throw new Error("No NovelAI API key configured. Enter your Persistent API Token.");

  const model = nai.model || "nai-diffusion-4-5-full";
  const [width, height] = String(nai.resolution || "1216x832").split("x").map(Number);
  const negativePrompt = nai.negativePrompt || "lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, blurry, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, text, watermark, username, logo, signature, dithering, halftone, screentone, scan artifacts, multiple views, blank page";
  const seed = nai.seed ?? Math.floor(Math.random() * 2147483647);
  const isV4 = isNovelAIV4Model(model);

  const parameters: any = {
    params_version: 3,
    width,
    height,
    scale: nai.guidance ?? 5,
    sampler: nai.sampler || "k_euler_ancestral",
    steps: nai.steps ?? 28,
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

  const charTags = includeCharacters && Array.isArray((scene as any).character_appearances)
    ? (scene as any).character_appearances.map((c: any) => ({ tags: String(c?.tags || "") })).filter((c: any) => c.tags)
    : [];

  if (isV4) {
    parameters.autoSmea = nai.smea ?? false;
    parameters.characterPrompts = charTags.map((char: any) => ({
      prompt: char.tags,
      uc: negativePrompt,
      center: { x: 0, y: 0 },
      enabled: true,
    }));
    parameters.v4_prompt = {
      caption: {
        base_caption: prompt,
        char_captions: charTags.map((char: any) => ({ char_caption: char.tags, centers: [{ x: 0, y: 0 }] })),
      },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: {
        base_caption: negativePrompt,
        char_captions: charTags.map(() => ({ char_caption: negativePrompt, centers: [{ x: 0, y: 0 }] })),
      },
      legacy_uc: false,
    };
  } else {
    parameters.sm = nai.smea ?? false;
    parameters.sm_dyn = nai.smeaDyn ?? false;
  }

  const directorImages = await gatherDirectorImages(userId, chatId, nai);
  if (directorImages.length > 0) {
    const fidelity = nai.referenceFidelity ?? 1;
    const paddedImages: string[] = [];
    for (const ref of directorImages) {
      try {
        paddedImages.push(await padDirectorRefImage(ref.data));
      } catch {
        paddedImages.push(ref.data);
      }
    }
    parameters.director_reference_images = paddedImages;
    parameters.director_reference_strength_values = directorImages.map((r) => r.strength ?? 0.5);
    parameters.director_reference_secondary_strength_values = directorImages.map(() => 1 - fidelity);
    parameters.director_reference_information_extracted = directorImages.map(() => 1.0);
    parameters.director_reference_descriptions = directorImages.map((r) => ({
      caption: { base_caption: r.refType || "character&style", char_captions: [] },
      legacy_uc: false,
    }));
  }

  const res = await fetch("https://image.novelai.net/ai/generate-image-stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nai.apiKey}`,
    },
    body: JSON.stringify({ input: prompt, model, action: "generate", parameters }),
  });
  if (!res.ok) throw new Error(`NovelAI API error ${res.status}: ${await res.text().catch(() => "Unknown error")}`);

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

  const primaryBuffer = fullBuffer.buffer.slice(fullBuffer.byteOffset, fullBuffer.byteOffset + fullBuffer.byteLength) as ArrayBuffer;
  let imageBytes = extractPngFromBuffer(primaryBuffer);
  if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;

  const pkIndex = findBytes(fullBuffer, [0x50, 0x4b, 0x03, 0x04]);
  if (pkIndex !== -1) {
    const zipSlice = fullBuffer.slice(pkIndex);
    const zipBuffer = zipSlice.buffer.slice(zipSlice.byteOffset, zipSlice.byteOffset + zipSlice.byteLength) as ArrayBuffer;
    imageBytes = extractPngFromBuffer(zipBuffer);
    if (imageBytes) return `data:image/png;base64,${uint8ToBase64(imageBytes)}`;
  }

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
