import { BUILTIN_TOOLS_MAP } from "./council/builtin-tools";
import { getSidecarSettings } from "./sidecar-settings.service";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as imagesSvc from "./images.service";
import * as gallerySvc from "./character-gallery.service";
import * as secretsSvc from "./secrets.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import { imageGenConnectionSecretKey } from "./image-gen-connections.service";
import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import { getComfyUIObjectInfo } from "../image-gen/comfyui-discovery";
import { normalizeComfyUIWorkflow } from "../image-gen/comfyui-import";
import { readComfyUIConfig } from "../image-gen/comfyui-workflow-storage";
import { patchWorkflow, type ComfyUIPatchValues } from "../image-gen/comfyui-workflow-patch";
import { rawGenerate } from "./generate.service";
import type { LlmMessage } from "../llm/types";
import type { ImageGenRequest } from "../image-gen/types";
import type { Message } from "../types/message";
import type { ImageGenConnectionProfile } from "../types/image-gen-connection";

// Ensure image gen providers are registered
import "../image-gen/index";

const IMAGE_SETTINGS_KEY = "imageGeneration";

interface ImageGenSettings {
  enabled: boolean;
  activeImageGenConnectionId?: string | null;
  includeCharacters: boolean;
  promptMode?: ImageGenPromptMode;
  customPrompt?: string;
  customNegativePrompt?: string;
  activePromptPresetId?: string | null;
  promptPresets?: ImageGenPromptPreset[];
  promptParserConnectionId?: string | null;
  promptParserModel?: string;
  promptParserParameters?: Record<string, any>;
  outputTarget?: ImageGenOutputTarget;
  sceneChangeThreshold: number;
  autoGenerate: boolean;
  forceGeneration: boolean;
  /** When true, generated chat attachment images may be re-sent to multimodal LLM context. */
  recycleGeneratedImages: boolean;
  /** Maximum generated images to re-send when recycling is enabled. */
  recycledImageLimit: number;
  backgroundOpacity: number;
  fadeTransitionMs: number;
  /** Per-session parameter overrides set via the Image Gen panel — merged on top of connection.default_parameters at generation time. */
  parameters?: Record<string, any>;
  /**
   * Maximum seconds to wait for the LLM sidecar/parser prompt generation phase.
   * Defaults to 60. Set to 0 to disable this timeout.
   */
  promptGenerationTimeoutSeconds?: number;
  /**
   * Maximum seconds to wait for the image provider generation phase.
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
  promptMode: "scene",
  customPrompt: "",
  customNegativePrompt: "",
  activePromptPresetId: null,
  promptPresets: [],
  promptParserConnectionId: null,
  promptParserModel: "",
  promptParserParameters: {},
  outputTarget: "background",
  sceneChangeThreshold: 2,
  autoGenerate: true,
  forceGeneration: false,
  recycleGeneratedImages: false,
  recycledImageLimit: 1,
  backgroundOpacity: 0.35,
  fadeTransitionMs: 800,
  promptGenerationTimeoutSeconds: 60,
  generationTimeoutSeconds: 300,
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
  scene?: SceneData;
  prompt: string;
  negativePrompt?: string;
  provider: string;
  imageDataUrl?: string;
  /** Persisted image ID in the images table */
  imageId?: string;
  /** Public URL for the image (works without authentication) */
  imageUrl?: string;
  /** Message created when outputTarget is chat_attachment. */
  message?: Message;
}

export type ImageGenPromptMode = "scene" | "custom" | "parsed_custom";
export type ImageGenOutputTarget = "background" | "chat_attachment" | "preview";

export interface ImageGenPromptPreset {
  id: string;
  name: string;
  mode: Exclude<ImageGenPromptMode, "scene">;
  prompt: string;
  negativePrompt?: string;
  parserConnectionId?: string | null;
  parserModel?: string;
  parserParameters?: Record<string, any>;
}

export interface GenerateImageOptions {
  forceGeneration?: boolean;
  promptMode?: ImageGenPromptMode;
  prompt?: string;
  negativePrompt?: string;
  promptPresetId?: string | null;
  outputTarget?: ImageGenOutputTarget;
  promptGenerationTimeoutSeconds?: number;
  generationTimeoutSeconds?: number;
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
  opts?: GenerateImageOptions
): Promise<ImageGenResult> {
  let settings = getImageGenSettings(userId);

  // Auto-migrate legacy settings to connection profiles
  await maybeAutoMigrate(userId, settings);
  settings = getImageGenSettings(userId);

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
  const controller = new AbortController();

  const registryKey = `${userId}:${chatId}`;
  const existing = activeImageGenerations.get(registryKey);
  if (existing) {
    existing.controller.abort(new Error("Image generation superseded by a newer request"));
  }
  activeImageGenerations.set(registryKey, { controller, startedAt: Date.now() });

  try {
    const cacheKey = `${userId}:${chatId}`;
    const promptInput = resolvePromptInput(settings, opts);
    const promptMode = opts?.promptMode || settings.promptMode || "scene";
    const outputTarget = opts?.outputTarget || settings.outputTarget || "background";
    const params = { ...connection.default_parameters, ...(settings.parameters || {}) };
    normalizeRandomSeed(params, !!provider.capabilities.parameters.seed);
    resolveProviderRandomSeed(params, connection.provider);
    const promptTimeoutSecs = resolveTimeoutSeconds(opts?.promptGenerationTimeoutSeconds, settings.promptGenerationTimeoutSeconds ?? 60);
    const promptSignal = createPhaseTimeoutSignal(
      controller.signal,
      promptTimeoutSecs,
      `Image prompt generation timed out after ${promptTimeoutSecs}s`,
    );
    let promptResult: Awaited<ReturnType<typeof resolveImagePrompt>>;
    try {
      promptResult = await resolveImagePrompt(
        userId,
        chatId,
        settings,
        promptMode,
        promptInput,
        params,
        connection.provider,
        promptSignal.signal,
      );
    } catch (err) {
      throw resolveAbortReason(promptSignal.signal) ?? err;
    } finally {
      promptSignal.cleanup();
    }

    if (promptResult.scene) {
      const previous = sceneCache.get(cacheKey) || null;
      const threshold = Math.max(1, Number(settings.sceneChangeThreshold || 2));
      const force = !!opts?.forceGeneration || !!settings.forceGeneration;

      if (!force && previous && !hasSceneChanged(promptResult.scene, previous, threshold)) {
        return {
          generated: false,
          reason: "Scene has not changed enough",
          scene: promptResult.scene,
          prompt: promptResult.prompt,
          negativePrompt: promptResult.negativePrompt,
          provider: connection.provider,
        };
      }
    }

    if (!promptResult.prompt.trim()) throw new Error("Image generation prompt is required");
    if (promptResult.negativePrompt) params.negativePrompt = promptResult.negativePrompt;

    // For NovelAI: pre-resolve director reference images (orchestration concern)
    if (connection.provider === "novelai") {
      const directorImages = await gatherDirectorImages(userId, chatId, params);
      if (directorImages.length > 0) {
        params.resolvedReferenceImages = directorImages;
      }

      // Pass character tags from scene analysis
      const charTags =
        settings.includeCharacters && Array.isArray((promptResult.scene as any)?.character_appearances)
          ? (promptResult.scene as any).character_appearances
              .map((c: any) => ({ tags: String(c?.tags || "") }))
              .filter((c: any) => c.tags)
          : [];
      if (charTags.length > 0) {
        params.characterTags = charTags;
      }
    }

    if (connection.provider === "comfyui") {
      await applyComfyUIWorkflowConfig(connection, params, promptResult.prompt, promptResult.negativePrompt);
    }

    const generationTimeoutSecs = resolveTimeoutSeconds(opts?.generationTimeoutSeconds, settings.generationTimeoutSeconds ?? 300);
    const generationSignal = createPhaseTimeoutSignal(
      controller.signal,
      generationTimeoutSecs,
      `Image generation timed out after ${generationTimeoutSecs}s`,
    );
    const request: ImageGenRequest = {
      prompt: promptResult.prompt,
      negativePrompt: promptResult.negativePrompt,
      model: connection.model,
      parameters: params,
      signal: generationSignal.signal,
    };

    let response: Awaited<ReturnType<typeof provider.generate>>;
    try {
      response = await provider.generate(apiKey || "", connection.api_url || "", request);
    } catch (err) {
      throw resolveAbortReason(generationSignal.signal) ?? err;
    } finally {
      generationSignal.cleanup();
    }

    // Persist the generated image to the images table
    let imageId: string | undefined;
    let imageUrl: string | undefined;
    let message: Message | undefined;
    if (response.imageDataUrl) {
      try {
        const image = await imagesSvc.saveImageFromDataUrl(
          userId,
          response.imageDataUrl,
          `image-gen-${connection.provider}-${Date.now()}.png`,
          { owner_chat_id: chatId },
        );
        imageId = image.id;
        imageUrl = `/api/v1/image-gen/results/${image.id}`;

        const chat = chatsSvc.getChat(userId, chatId);
        if (chat?.character_id) {
          try {
            gallerySvc.addToGallery(userId, chat.character_id, image.id, "Generated image");
          } catch {
            // Gallery linkage is best-effort; the generated image itself was persisted.
          }
        }

        if (outputTarget === "chat_attachment") {
          message = chatsSvc.createMessage(chatId, {
            is_user: false,
            name: "ImageGen",
            content: "",
            extra: {
              image_gen: {
                provider: connection.provider,
                prompt: promptResult.prompt,
                negativePrompt: promptResult.negativePrompt,
                mode: promptMode,
              },
              attachments: [
                {
                  type: "image",
                  image_id: image.id,
                  mime_type: image.mime_type,
                  original_filename: image.original_filename,
                  width: image.width ?? undefined,
                  height: image.height ?? undefined,
                },
              ],
            },
          }, userId);
        }
      } catch {
        // Persistence failure is non-fatal — the data URL is still returned
      }
    }

    if (promptResult.scene) sceneCacheSet(cacheKey, promptResult.scene);
    return {
      generated: true,
      scene: promptResult.scene,
      prompt: promptResult.prompt,
      negativePrompt: promptResult.negativePrompt,
      provider: connection.provider,
      imageDataUrl: response.imageDataUrl,
      imageId,
      imageUrl,
      message,
    };
  } finally {
    // Only clear the registry entry if it still points at our controller —
    // a newer request may have already overwritten it.
    if (activeImageGenerations.get(registryKey)?.controller === controller) {
      activeImageGenerations.delete(registryKey);
    }
  }
}

function resolveTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function createPhaseTimeoutSignal(
  parentSignal: AbortSignal,
  timeoutSeconds: number,
  timeoutMessage: string,
): { signal: AbortSignal; cleanup: () => void } {
  if (timeoutSeconds <= 0) return { signal: parentSignal, cleanup: () => {} };

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutSeconds * 1000);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

function resolveAbortReason(signal: AbortSignal): Error | null {
  return signal.aborted && signal.reason instanceof Error ? signal.reason : null;
}

async function applyComfyUIWorkflowConfig(
  connection: ImageGenConnectionProfile,
  params: Record<string, any>,
  prompt: string,
  negativePrompt?: string,
): Promise<void> {
  if (params.workflow && typeof params.workflow === "object") return;

  const config = readComfyUIConfig(connection.metadata);
  if (!config) return;

  const mappings = config.field_mappings || [];
  const hasPositivePrompt = mappings.some((mapping) => mapping.mappedAs === "positive_prompt");
  if (!hasPositivePrompt) {
    throw new Error("Imported ComfyUI workflow must map at least one positive prompt field");
  }

  const objectInfo = await getComfyUIObjectInfo(connection.api_url || "http://localhost:8188");
  const normalizedWorkflow = normalizeComfyUIWorkflow(
    config.workflow_api_json || config.workflow_json,
    objectInfo ?? undefined,
  );

  const customValues =
    params.comfyui_custom_fields && typeof params.comfyui_custom_fields === "object"
      ? params.comfyui_custom_fields as Record<string, unknown>
      : params.custom && typeof params.custom === "object"
        ? params.custom as Record<string, unknown>
        : undefined;

  const patchValues: ComfyUIPatchValues = {
    positive_prompt: prompt,
    negative_prompt: negativePrompt || params.negativePrompt,
    steps: numberParam(params.steps),
    cfg: numberParam(params.cfg),
    sampler_name: stringParam(params.sampler_name),
    scheduler: stringParam(params.scheduler),
    width: numberParam(params.width),
    height: numberParam(params.height),
    checkpoint: stringParam(params.checkpoint || params.ckpt_name),
    custom: customValues,
  };

  const extraFieldValues = params.comfyui_field_values;
  if (extraFieldValues && typeof extraFieldValues === "object") {
    Object.assign(patchValues, extraFieldValues);
  }
  patchValues.seed = resolveComfySeedParam(patchValues.seed ?? params.seed);

  params.workflow = patchWorkflow(normalizedWorkflow.apiWorkflow, mappings, patchValues);
  params.workflowFormat = "api_prompt";
  params.preserveImportedWorkflow = true;
}

function numberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveComfySeedParam(value: unknown): number | undefined {
  const seed = numberParam(value);
  if (seed === undefined) return undefined;
  if (seed !== -1) return seed;

  return randomImageSeed();
}

function normalizeRandomSeed(params: Record<string, any>, supportsSeed: boolean): void {
  if (!supportsSeed) return;
  const seed = params.seed;
  if (seed == null || (typeof seed === "string" && seed.trim() === "")) {
    params.seed = -1;
  }
}

function resolveProviderRandomSeed(params: Record<string, any>, providerName: string): void {
  if (providerName === "swarmui") return;
  if (numberParam(params.seed) === -1) params.seed = randomImageSeed();
}

function randomImageSeed(): number {
  const max = 2_147_483_647;
  const range = max + 1;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const values = new Uint32Array(1);

  do {
    globalThis.crypto.getRandomValues(values);
  } while (values[0] >= limit);

  return values[0] % range;
}

function resolvePromptInput(settings: ImageGenSettings, opts?: GenerateImageOptions): ImageGenPromptPreset {
  const preset = (settings.promptPresets || []).find((p) => p.id === (opts?.promptPresetId || settings.activePromptPresetId));
  const requestedMode = opts?.promptMode || preset?.mode || settings.promptMode || "custom";
  return {
    id: preset?.id || "inline",
    name: preset?.name || "Inline prompt",
    mode: requestedMode === "parsed_custom" ? "parsed_custom" : "custom",
    prompt: opts?.prompt ?? preset?.prompt ?? settings.customPrompt ?? "",
    negativePrompt: opts?.negativePrompt ?? preset?.negativePrompt ?? settings.customNegativePrompt ?? "",
    parserConnectionId: preset?.parserConnectionId ?? settings.promptParserConnectionId ?? null,
    parserModel: preset?.parserModel ?? settings.promptParserModel ?? "",
    parserParameters: preset?.parserParameters ?? settings.promptParserParameters ?? {},
  };
}

async function resolveImagePrompt(
  userId: string,
  chatId: string,
  settings: ImageGenSettings,
  mode: ImageGenPromptMode,
  input: ImageGenPromptPreset,
  imageParams: Record<string, any>,
  providerName: string,
  signal?: AbortSignal,
): Promise<{ prompt: string; negativePrompt?: string; scene?: SceneData }> {
  if (mode === "custom") return { prompt: input.prompt, negativePrompt: input.negativePrompt };
  if (mode === "parsed_custom") return parseCustomPrompt(userId, chatId, settings, input, signal);

  const scene = await analyzeScene(userId, chatId, settings, signal);
  return {
    scene,
    prompt: buildImagePrompt(scene, providerName, settings.includeCharacters, imageParams),
    negativePrompt: input.negativePrompt,
  };
}

async function parseCustomPrompt(
  userId: string,
  chatId: string,
  settings: ImageGenSettings,
  input: ImageGenPromptPreset,
  signal?: AbortSignal,
): Promise<{ prompt: string; negativePrompt?: string }> {
  const parser = await resolvePromptParser(userId, settings, input);
  const response = await rawGenerate(userId, {
    provider: parser.connection.provider,
    model: parser.model,
    connection_id: parser.connection.id,
    messages: [
      {
        role: "system",
        content:
          "You rewrite roleplay chat context into an image generation prompt. Return either plain prompt text or JSON with keys prompt and negative_prompt. Do not include markdown fences unless returning JSON.",
      },
      ...buildContextMessages(userId, chatId),
      {
        role: "user",
        content: `User image prompt instructions:\n${input.prompt}\n\nReturn the final image prompt now.`,
      },
    ],
    parameters: parser.parameters,
    signal,
  });

  return parsePromptResponse(response.content || "", input.negativePrompt);
}

function parsePromptResponse(input: string, fallbackNegative?: string): { prompt: string; negativePrompt?: string } {
  const cleaned = input.trim();
  const fromFence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fromFence?.[1] || cleaned).trim();
  if (candidate.startsWith("{")) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        prompt: String(parsed.prompt || parsed.positive_prompt || "").trim(),
        negativePrompt: parsed.negative_prompt || parsed.negativePrompt || fallbackNegative,
      };
    } catch {
      // Fall through to plain text.
    }
  }
  return { prompt: candidate, negativePrompt: fallbackNegative };
}

async function resolvePromptParser(userId: string, settings: ImageGenSettings, input?: ImageGenPromptPreset) {
  const { getConnection } = await import("./connections.service");
  const configuredId = input?.parserConnectionId || settings.promptParserConnectionId;
  let model = input?.parserModel || settings.promptParserModel || "";
  let parameters = input?.parserParameters || settings.promptParserParameters || {};

  if (configuredId) {
    const connection = getConnection(userId, configuredId);
    if (!connection) throw new Error("Image prompt parser connection not found");
    return { connection, model: model || connection.model, parameters };
  }

  const sidecar = getSidecarSettings(userId);
  if (!sidecar.connectionProfileId || !sidecar.model) {
    throw new Error("Image prompt parser connection is required. Select one in ImageGen settings or configure the Council sidecar.");
  }

  const connection = getConnection(userId, sidecar.connectionProfileId);
  if (!connection) throw new Error("Sidecar connection not found");
  model = model || sidecar.model;
  parameters = Object.keys(parameters).length > 0 ? parameters : {
    temperature: sidecar.temperature,
    top_p: sidecar.topP,
    max_tokens: sidecar.maxTokens,
  };
  return { connection, model, parameters };
}

// --- Scene Analysis ---

async function analyzeScene(userId: string, chatId: string, settings: ImageGenSettings, signal?: AbortSignal): Promise<SceneData> {
  const parser = await resolvePromptParser(userId, settings);

  const tool = BUILTIN_TOOLS_MAP.get("generate_scene");
  if (!tool) throw new Error("generate_scene council tool is unavailable");

  const response = await rawGenerate(userId, {
    provider: parser.connection.provider,
    model: parser.model,
    connection_id: parser.connection.id,
    messages: [
      {
        role: "system",
        content: `${tool.prompt}\n\nYou must return ONLY valid JSON with the exact schema keys and no markdown fences.`,
      },
      ...buildContextMessages(userId, chatId),
      { role: "user", content: "Return scene JSON now." },
    ],
    parameters: {
      ...parser.parameters,
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
  const settings = { ...DEFAULT_IMAGE_SETTINGS, ...(row?.value || {}) };
  const savedConnectionId = settings.activeImageGenConnectionId || null;
  const savedConnection = savedConnectionId
    ? imageGenConnSvc.getConnection(userId, savedConnectionId)
    : null;

  if (savedConnection) return settings;

  const defaultConnection = imageGenConnSvc.getDefaultConnection(userId);
  if (!defaultConnection) {
    if (savedConnectionId) {
      const next = { ...settings, activeImageGenConnectionId: null };
      settingsSvc.putSetting(userId, IMAGE_SETTINGS_KEY, next);
      return next;
    }
    return settings;
  }

  const next = { ...settings, activeImageGenConnectionId: defaultConnection.id };
  settingsSvc.putSetting(userId, IMAGE_SETTINGS_KEY, next);
  return next;
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
