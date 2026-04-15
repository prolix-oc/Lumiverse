import { BUILTIN_TOOLS_MAP } from "./council/builtin-tools";
import { getSidecarSettings } from "./sidecar-settings.service";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as imagesSvc from "./images.service";
import * as secretsSvc from "./secrets.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import { imageGenConnectionSecretKey } from "./image-gen-connections.service";
import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import { rawGenerate } from "./generate.service";
import type { LlmMessage } from "../llm/types";
import type { ImageGenRequest } from "../image-gen/types";

// Ensure image gen providers are registered
import "../image-gen/index";

const IMAGE_SETTINGS_KEY = "imageGeneration";

interface ImageGenSettings {
  enabled: boolean;
  activeImageGenConnectionId?: string | null;
  includeCharacters: boolean;
  sceneChangeThreshold: number;
  autoGenerate: boolean;
  forceGeneration: boolean;
  backgroundOpacity: number;
  fadeTransitionMs: number;
  /** Per-session parameter overrides set via the Image Gen panel — merged on top of connection.default_parameters at generation time. */
  parameters?: Record<string, any>;
  /**
   * Maximum seconds to wait for the image provider to respond.
   * Defaults to 300 (5 minutes). Set to 0 to disable the timeout entirely.
   */
  generationTimeoutSeconds?: number;
  // Legacy fields preserved for auto-migration
  provider?: string;
  google?: any;
  nanogpt?: any;
  novelai?: any;
}

const DEFAULT_IMAGE_SETTINGS: ImageGenSettings = {
  enabled: false,
  activeImageGenConnectionId: null,
  includeCharacters: false,
  sceneChangeThreshold: 2,
  autoGenerate: true,
  forceGeneration: false,
  backgroundOpacity: 0.35,
  fadeTransitionMs: 800,
};

export interface SceneData {
  environment: string;
  time_of_day: string;
  weather: string;
  mood: string;
  focal_detail: string;
  palette_override?: string;
  scene_changed: boolean;
}

export interface ImageGenResult {
  generated: boolean;
  reason?: string;
  scene: SceneData;
  prompt: string;
  provider: string;
  imageDataUrl?: string;
  /** Persisted image ID in the images table */
  imageId?: string;
  /** Public URL for the image (works without authentication) */
  imageUrl?: string;
}

const SCENE_CACHE_MAX = 200;
const sceneCache = new Map<string, SceneData>();
const SCENE_FIELDS: Array<keyof SceneData> = ["environment", "time_of_day", "weather", "mood", "focal_detail"];

// Tracks in-flight image generations keyed by `${userId}:${chatId}` so a new
// request for the same chat can abort an existing one mid-flight.
const activeImageGenerations = new Map<string, { controller: AbortController; startedAt: number }>();

function sceneCacheSet(key: string, value: SceneData): void {
  // Delete first so re-insertion moves key to end (most-recently-used)
  sceneCache.delete(key);
  sceneCache.set(key, value);
  if (sceneCache.size > SCENE_CACHE_MAX) {
    const oldest = sceneCache.keys().next().value;
    if (oldest !== undefined) sceneCache.delete(oldest);
  }
}

// --- Public API ---

export function getImageProviders() {
  const providers = getImageProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
  return { providers };
}

export async function generateSceneBackground(
  userId: string,
  chatId: string,
  opts?: { forceGeneration?: boolean }
): Promise<ImageGenResult> {
  const settings = getImageGenSettings(userId);

  // Auto-migrate legacy settings to connection profiles
  await maybeAutoMigrate(userId, settings);

  // Resolve connection profile
  const connectionId = settings.activeImageGenConnectionId;
  if (!connectionId) {
    throw new Error("No image generation connection selected. Create one in Settings → Image Gen Connections.");
  }

  const connection = imageGenConnSvc.getConnection(userId, connectionId);
  if (!connection) throw new Error("Image generation connection not found");

  const provider = getImageProvider(connection.provider);
  if (!provider) throw new Error(`Unknown image generation provider: ${connection.provider}`);

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(connection.id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(`No API key for image generation connection "${connection.name}"`);
  }

  // Register this generation up-front so a newer request for the same chat
  // can abort it during *any* phase (scene analysis as well as image gen).
  // The timeout is an optional trigger; supersession works independently.
  const timeoutSecs = settings.generationTimeoutSeconds ?? 300;
  const controller = new AbortController();
  const timeoutHandle = timeoutSecs > 0
    ? setTimeout(() => controller.abort(new Error(`Image generation timed out after ${timeoutSecs}s`)), timeoutSecs * 1000)
    : null;

  const registryKey = `${userId}:${chatId}`;
  const existing = activeImageGenerations.get(registryKey);
  if (existing) {
    existing.controller.abort(new Error("Image generation superseded by a newer request"));
  }
  activeImageGenerations.set(registryKey, { controller, startedAt: Date.now() });

  try {
    // Scene analysis — abortable by supersession or timeout
    const scene = await analyzeScene(userId, chatId, controller.signal);

    // Scene change threshold
    const cacheKey = `${userId}:${chatId}`;
    const previous = sceneCache.get(cacheKey) || null;
    const threshold = Math.max(1, Number(settings.sceneChangeThreshold || 2));
    const force = !!opts?.forceGeneration || !!settings.forceGeneration;

    if (!force && previous && !hasSceneChanged(scene, previous, threshold)) {
      return {
        generated: false,
        reason: "Scene has not changed enough",
        scene,
        prompt: buildImagePrompt(scene, connection.provider, settings.includeCharacters, connection.default_parameters),
        provider: connection.provider,
      };
    }

    // Build prompt
    const prompt = buildImagePrompt(scene, connection.provider, settings.includeCharacters, connection.default_parameters);

    // Prepare request parameters — connection defaults first, then panel-level overrides
    const params = { ...connection.default_parameters, ...(settings.parameters || {}) };

    // For NovelAI: pre-resolve director reference images (orchestration concern)
    if (connection.provider === "novelai") {
      const directorImages = await gatherDirectorImages(userId, chatId, params);
      if (directorImages.length > 0) {
        params.resolvedReferenceImages = directorImages;
      }

      // Pass character tags from scene analysis
      const charTags =
        settings.includeCharacters && Array.isArray((scene as any).character_appearances)
          ? (scene as any).character_appearances
              .map((c: any) => ({ tags: String(c?.tags || "") }))
              .filter((c: any) => c.tags)
          : [];
      if (charTags.length > 0) {
        params.characterTags = charTags;
      }
    }

    const request: ImageGenRequest = {
      prompt,
      model: connection.model,
      parameters: params,
      signal: controller.signal,
    };

    const response = await provider.generate(apiKey || "", connection.api_url || "", request);

    // Persist the generated image to the images table
    let imageId: string | undefined;
    let imageUrl: string | undefined;
    if (response.imageDataUrl) {
      try {
        const image = await imagesSvc.saveImageFromDataUrl(
          userId,
          response.imageDataUrl,
          `image-gen-${connection.provider}-${Date.now()}.png`
        );
        imageId = image.id;
        imageUrl = `/api/v1/image-gen/results/${image.id}`;
      } catch {
        // Persistence failure is non-fatal — the data URL is still returned
      }
    }

    sceneCacheSet(cacheKey, scene);
    return {
      generated: true,
      scene,
      prompt,
      provider: connection.provider,
      imageDataUrl: response.imageDataUrl,
      imageId,
      imageUrl,
    };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    // Only clear the registry entry if it still points at our controller —
    // a newer request may have already overwritten it.
    if (activeImageGenerations.get(registryKey)?.controller === controller) {
      activeImageGenerations.delete(registryKey);
    }
  }
}

// --- Scene Analysis ---

async function analyzeScene(userId: string, chatId: string, signal?: AbortSignal): Promise<SceneData> {
  const sidecar = getSidecarSettings(userId);
  if (!sidecar.connectionProfileId || !sidecar.model) {
    throw new Error("Sidecar LLM connection is required for scene analysis — configure it in the Council panel");
  }

  // Use LLM connection service for sidecar (not image gen connections)
  const { getConnection } = await import("./connections.service");
  const conn = getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const tool = BUILTIN_TOOLS_MAP.get("generate_scene");
  if (!tool) throw new Error("generate_scene council tool is unavailable");

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages: [
      {
        role: "system",
        content: `${tool.prompt}\n\nYou must return ONLY valid JSON with the exact schema keys and no markdown fences.`,
      },
      ...buildContextMessages(userId, chatId),
      { role: "user", content: "Return scene JSON now." },
    ],
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens,
    },
    signal,
  });

  return parseSceneJson(response.content || "");
}

function buildContextMessages(userId: string, chatId: string): LlmMessage[] {
  const msgs: LlmMessage[] = [];
  const chat = chatsSvc.getChat(userId, chatId);
  if (chat) {
    const char = charactersSvc.getCharacter(userId, chat.character_id);
    if (char) {
      const charInfo = [
        char.name && `Name: ${char.name}`,
        char.description && `Description: ${char.description}`,
        char.scenario && `Scenario: ${char.scenario}`,
      ]
        .filter(Boolean)
        .join("\n");
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

// --- Prompt Building ---

function buildImagePrompt(
  scene: SceneData,
  providerName: string,
  includeCharacters: boolean,
  params: Record<string, any>
): string {
  if (providerName === "novelai") {
    const tags: string[] = ["illustration", "anime coloring"];

    const compositionRating = Array.isArray((scene as any).composition_rating)
      ? (scene as any).composition_rating
      : null;
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
      const names = String((scene as any).character_names || "")
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean);
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

  // Prose prompt for Google Gemini and NanoGPT
  let prompt = "";
  if (providerName === "google_gemini") {
    const ar = params.aspectRatio || "16:9";
    const res = params.imageSize || "1K";
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
    prompt +=
      "\nThis is a background/environment image ONLY. Do NOT include any people, characters, or humanoid figures in the image.";
  }
  prompt += "\nStyle: anime, detailed, high quality, vibrant colors.";
  return prompt;
}

// --- Scene Change Detection ---

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

// --- Director Reference Image Resolution (NovelAI orchestration) ---

async function gatherDirectorImages(
  userId: string,
  chatId: string,
  params: Record<string, any>
): Promise<Array<{ data: string; strength: number; infoExtracted: number; refType: string }>> {
  const images: Array<{ data: string; strength: number; infoExtracted: number; refType: string }> = [];
  const strength = params.referenceStrength ?? 0.5;
  const infoExtracted = params.referenceInfoExtracted ?? 1;
  const manualRefType = params.referenceType || "character&style";
  const avatarRefType = params.avatarReferenceType || "character";

  // Manual reference images from connection parameters
  for (const ref of params.referenceImages || []) {
    if (ref?.data) images.push({ data: ref.data, strength, infoExtracted, refType: manualRefType });
  }

  // Character avatar
  if (params.includeCharacterAvatar) {
    const chat = chatsSvc.getChat(userId, chatId);
    if (chat) {
      const character = charactersSvc.getCharacter(userId, chat.character_id);
      if (character?.image_id) {
        const path = await imagesSvc.getImageFilePath(userId, character.image_id);
        if (path) {
          const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
          images.push({ data: uint8ToBase64(bytes), strength, infoExtracted, refType: avatarRefType });
        }
      }
    }
  }

  // Persona avatar
  if (params.includePersonaAvatar) {
    const personas = personasSvc.listPersonas(userId, { limit: 100, offset: 0 }).data;
    const persona = personas.find((p) => p.is_default) || personas[0];
    if (persona?.image_id) {
      const path = await imagesSvc.getImageFilePath(userId, persona.image_id);
      if (path) {
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
        images.push({ data: uint8ToBase64(bytes), strength, infoExtracted, refType: avatarRefType });
      }
    }
  }

  return images;
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

// --- Settings ---

export function getImageGenSettings(userId: string): ImageGenSettings {
  const row = settingsSvc.getSetting(userId, IMAGE_SETTINGS_KEY);
  return { ...DEFAULT_IMAGE_SETTINGS, ...(row?.value || {}) };
}

// --- Auto-Migration (Legacy Settings → Connection Profiles) ---

async function maybeAutoMigrate(userId: string, settings: ImageGenSettings): Promise<void> {
  // Skip if user already has connection profiles
  const existing = imageGenConnSvc.listConnections(userId, { limit: 1, offset: 0 });
  if (existing.total > 0) return;

  // Skip if no legacy provider-specific config exists
  const hasLegacy =
    settings.nanogpt?.apiKey || settings.novelai?.apiKey || settings.google?.connectionProfileId;
  if (!hasLegacy) return;

  let defaultConnectionId: string | null = null;

  // Migrate NanoGPT
  if (settings.nanogpt?.apiKey) {
    const nano = settings.nanogpt;
    const conn = await imageGenConnSvc.createConnection(userId, {
      name: "Nano-GPT (migrated)",
      provider: "nanogpt",
      model: nano.model || "hidream",
      is_default: settings.provider === "nanogpt",
      default_parameters: {
        size: nano.size || "1024x1024",
        strength: nano.strength ?? 0.8,
        guidanceScale: nano.guidanceScale ?? 7.5,
        numInferenceSteps: nano.numInferenceSteps ?? 30,
        seed: nano.seed ?? null,
        referenceImages: nano.referenceImages || [],
      },
      api_key: nano.apiKey,
    });
    if (settings.provider === "nanogpt") defaultConnectionId = conn.id;
  }

  // Migrate NovelAI
  if (settings.novelai?.apiKey) {
    const nai = settings.novelai;
    const conn = await imageGenConnSvc.createConnection(userId, {
      name: "NovelAI (migrated)",
      provider: "novelai",
      model: nai.model || "nai-diffusion-4-5-full",
      is_default: settings.provider === "novelai",
      default_parameters: {
        sampler: nai.sampler || "k_euler_ancestral",
        resolution: nai.resolution || "1216x832",
        steps: nai.steps ?? 28,
        guidance: nai.guidance ?? 5,
        negativePrompt: nai.negativePrompt || "",
        smea: nai.smea ?? false,
        smeaDyn: nai.smeaDyn ?? false,
        seed: nai.seed ?? null,
        referenceImages: nai.referenceImages || [],
        includeCharacterAvatar: nai.includeCharacterAvatar ?? false,
        includePersonaAvatar: nai.includePersonaAvatar ?? false,
        referenceStrength: nai.referenceStrength ?? 0.5,
        referenceInfoExtracted: nai.referenceInfoExtracted ?? 1,
        referenceFidelity: nai.referenceFidelity ?? 1,
        referenceType: nai.referenceType || "character&style",
        avatarReferenceType: nai.avatarReferenceType || "character",
      },
      api_key: nai.apiKey,
    });
    if (settings.provider === "novelai") defaultConnectionId = conn.id;
  }

  // Migrate Google Gemini (borrow API key from LLM connection)
  if (settings.google?.connectionProfileId) {
    const { getConnection, connectionSecretKey } = await import("./connections.service");
    const llmConn = getConnection(userId, settings.google.connectionProfileId);
    if (llmConn) {
      const llmApiKey = await secretsSvc.getSecret(userId, connectionSecretKey(settings.google.connectionProfileId));
      const conn = await imageGenConnSvc.createConnection(userId, {
        name: "Google Gemini Image (migrated)",
        provider: "google_gemini",
        model: settings.google.model || "gemini-3.1-flash-image",
        api_url: llmConn.api_url || "",
        is_default: settings.provider === "google_gemini",
        default_parameters: {
          aspectRatio: settings.google.aspectRatio || "16:9",
          imageSize: settings.google.imageSize || "1K",
        },
        api_key: llmApiKey || undefined,
      });
      if (settings.provider === "google_gemini") defaultConnectionId = conn.id;
    }
  }

  // Set the active connection ID
  if (defaultConnectionId) {
    const currentSettings = settingsSvc.getSetting(userId, IMAGE_SETTINGS_KEY)?.value || {};
    settingsSvc.putSetting(userId, IMAGE_SETTINGS_KEY, {
      ...currentSettings,
      activeImageGenConnectionId: defaultConnectionId,
    });
  }
}
