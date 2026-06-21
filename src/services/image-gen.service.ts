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
import * as imageGenBindingsSvc from "./image-gen-preset-bindings.service";
import * as characterLoraSvc from "./character-lora.service";
import { buildMacroEnvForChat } from "./chats.service";
import { evaluate as evaluateMacros, registry as macroRegistry } from "../macros";
import sharp from "../utils/sharp-config";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import { getComfyUIObjectInfo, resolveComfyTarget } from "../image-gen/comfyui-discovery";
import { normalizeComfyUIWorkflow } from "../image-gen/comfyui-import";
import { readComfyUIConfig } from "../image-gen/comfyui-workflow-storage";
import { patchWorkflow, type ComfyUIPatchValues } from "../image-gen/comfyui-workflow-patch";
import { uploadComfyImage } from "../image-gen/providers/comfy-runner";
import { rawGenerate } from "./generate.service";
import type { LlmMessage } from "../llm/types";
import type { ImageGenRequest } from "../image-gen/types";
import type { Message } from "../types/message";
import type { ImageGenConnectionProfile } from "../types/image-gen-connection";

// Ensure image gen providers are registered
import "../image-gen/index";

const IMAGE_SETTINGS_KEY = "imageGeneration";
const RELAY_IMAGE_PREVIEW_MAX_CHARS = 180 * 1024;

async function buildRelayImagePreview(dataUrl: string): Promise<string | undefined> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return undefined;
  const input = Buffer.from(match[2], "base64");

  for (const size of [640, 480, 320]) {
    for (const quality of [75, 60, 45, 30]) {
      try {
        const output = await sharp(input)
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
        const preview = `data:image/webp;base64,${output.toString("base64")}`;
        if (preview.length <= RELAY_IMAGE_PREVIEW_MAX_CHARS) return preview;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

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
  /** When true, generated images are also linked into the active chat's character gallery. */
  addToGallery?: boolean;
  backgroundOpacity: number;
  fadeTransitionMs: number;
  /** @deprecated Legacy global parameter bag. Provider parameters live on connection.default_parameters. */
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
  /**
   * Maximum recent chat messages sent to the prompt parser for scene analysis
   * and parsed custom prompts. Defaults to 3. Minimum 1.
   */
  promptContextMessageLimit?: number;
  /** Frontend-owned: show the resolved prompt in an editable modal before generating. */
  previewPromptBeforeGenerate?: boolean;
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
  addToGallery: true,
  backgroundOpacity: 0.35,
  fadeTransitionMs: 800,
  promptGenerationTimeoutSeconds: 60,
  generationTimeoutSeconds: 300,
  promptContextMessageLimit: 3,
};

const DEFAULT_PROMPT_CONTEXT_MESSAGE_LIMIT = 3;

function resolveContextMessageLimit(settings: ImageGenSettings): number {
  const raw = Number(settings.promptContextMessageLimit);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PROMPT_CONTEXT_MESSAGE_LIMIT;
  return Math.floor(raw);
}

export interface SceneData {
  environment: string;
  time_of_day: string;
  weather: string;
  mood: string;
  focal_detail: string;
  palette_override?: string;
  scene_changed: boolean;
  character_names?: string;
  character_appearances?: Array<{
    name?: string;
    role?: string;
    appearance?: string;
    tags?: string;
  }>;
  composition_subjects?: string;
  composition_shot?: string;
  composition_camera?: string;
  composition_rating?: string[];
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
  /** Message created (chat_attachment) or patched (attach_to_message) by this generation. */
  message?: Message;
  /** Job id streamed alongside progress events so the frontend can correlate. */
  jobId?: string;
}

export type ImageGenPromptMode = "scene" | "custom" | "parsed_custom";
export type ImageGenOutputTarget =
  | "background"
  | "chat_attachment"
  | "preview"
  | "attach_to_message";

export type ImageGenPresetKind = "main" | "character" | "persona" | "captioning";

export interface ImageGenPromptPreset {
  id: string;
  name: string;
  mode: Exclude<ImageGenPromptMode, "scene">;
  prompt: string;
  negativePrompt?: string;
  parserConnectionId?: string | null;
  parserModel?: string;
  parserParameters?: Record<string, any>;
  /** Whether this preset is intended as a main scene preset or as a per-character snippet. Legacy entries default to "main". */
  kind?: ImageGenPresetKind;
}

export interface GenerateImageOptions {
  forceGeneration?: boolean;
  promptMode?: ImageGenPromptMode;
  prompt?: string;
  negativePrompt?: string;
  promptPresetId?: string | null;
  outputTarget?: ImageGenOutputTarget;
  /** Existing message to attach the generated image to (output target = attach_to_message). */
  attachToMessageId?: string;
  /** When true, the parser is skipped and `prompt`/`negativePrompt` are sent verbatim. Used after the preview-prompt modal. */
  skipParse?: boolean;
  /** Caller-supplied job id so the frontend can subscribe to progress events before the HTTP request returns. */
  clientJobId?: string;
  promptGenerationTimeoutSeconds?: number;
  generationTimeoutSeconds?: number;
}

const SCENE_CACHE_MAX = 200;
const sceneCache = new Map<string, SceneData>();
const SCENE_FIELDS: Array<keyof SceneData> = ["environment", "time_of_day", "weather", "mood", "focal_detail"];

const CUSTOM_PROMPT_PARSER_SYSTEM =
  "You are a visual scene analyst and image-prompt writer. Read the current roleplay chat context and rewrite it into the final image generation prompt. Preserve the current scene, visible subjects, actions, composition, lighting, and mood. Follow the user's parser instructions, but do not treat those instructions as the final prompt unless they explicitly say so. Return either plain prompt text or JSON with keys prompt and negative_prompt. Do not include markdown fences unless returning JSON.";

const CHARACTER_AWARE_SCENE_INSTRUCTIONS = `Character-aware mode is enabled because the user selected Include Characters.
Override any earlier environment-only instruction: include visible characters and the user persona when the context supports it.

In addition to the base scene keys, include these optional JSON keys:
- character_names: comma-separated names of visible subjects.
- character_appearances: array of objects with name, role, appearance, and tags. Use concise visual image-generation tags in tags.
- composition_subjects: the main subject grouping or pose/action relationship.
- composition_shot: shot framing such as close-up, waist-up, full-body, or wide shot.
- composition_camera: camera angle or lens direction.
- composition_rating: array of concise composition tags.

Do not invent unsupported character details. Use character/persona descriptions and the latest chat actions.`;

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

  const jobId = opts?.clientJobId || crypto.randomUUID();

  try {
    const cacheKey = `${userId}:${chatId}`;
    const promptInput = await resolvePromptInput(userId, chatId, settings, opts);
    const promptMode = opts?.skipParse
      ? "custom"
      : opts?.promptMode || settings.promptMode || "scene";
    const outputTarget = opts?.outputTarget || settings.outputTarget || "background";
    const params = { ...connection.default_parameters };
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

    // Resolve the active chat's character LoRA binding (if any) and weave it
    // into the prompt + provider params. Done before provider-specific work so
    // every provider that opts in sees the spliced prompt; only Comfy/Swarm
    // actually consume the workflow/body LoRA params today.
    const characterLora = resolveCharacterLoraForChat(userId, chatId);
    if (characterLora?.base_tags) {
      promptResult.prompt = composeWithBaseTags(characterLora.base_tags, promptResult.prompt);
    }

    if (!promptResult.prompt.trim()) throw new Error("Image generation prompt is required");
    if (promptResult.negativePrompt) params.negativePrompt = promptResult.negativePrompt;

    if (characterLora) {
      applyCharacterLoraToParams(connection.provider, params, characterLora);
    }

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

    // Resolve img2img source images (init image) for providers that accept
    // image input. Reuses the reference-image config surface; SwarmUI/ComfyUI
    // consume the first image, Gemini/OpenRouter/SD API consume all of them.
    if (
      connection.provider === "swarmui" ||
      connection.provider === "comfyui" ||
      connection.provider === "google_gemini" ||
      connection.provider === "openrouter" ||
      connection.provider === "openai" ||
      connection.provider === "sdapi"
    ) {
      const sources = await resolveSourceImages(userId, chatId, params);
      if (sources.length > 0) params.resolvedSourceImages = sources;
    }

    if (connection.provider === "comfyui" || connection.provider === "swarmui") {
      await applyComfyUIWorkflowConfig(connection, params, promptResult.prompt, promptResult.negativePrompt, characterLora, apiKey ?? undefined);
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
      response = await runProviderGeneration(provider, apiKey || "", connection.api_url || "", request, {
        jobId,
        chatId,
        userId,
      });
    } catch (err) {
      eventBus.emit(
        EventType.IMAGE_GEN_ERROR,
        { assetId: jobId, chatId, message: err instanceof Error ? err.message : String(err) },
        userId,
      );
      throw resolveAbortReason(generationSignal.signal) ?? err;
    } finally {
      generationSignal.cleanup();
    }

    // Persist the generated image to the images table
    let imageId: string | undefined;
    let imageUrl: string | undefined;
    let message: Message | undefined;
    if (response.imageDataUrl) {
      const image = await imagesSvc.saveImageFromDataUrl(
        userId,
        response.imageDataUrl,
        `image-gen-${connection.provider}-${Date.now()}.png`,
        { owner_chat_id: chatId },
      );
      imageId = image.id;
      imageUrl = `/api/v1/image-gen/results/${image.id}`;
      const relayPreviewUrl = await buildRelayImagePreview(response.imageDataUrl);

      const newAttachment = {
        type: "image" as const,
        image_id: image.id,
        mime_type: image.mime_type,
        original_filename: image.original_filename,
        width: image.width ?? undefined,
        height: image.height ?? undefined,
        relay_preview_url: relayPreviewUrl,
      };
      const imageGenMeta = {
        provider: connection.provider,
        prompt: promptResult.prompt,
        negativePrompt: promptResult.negativePrompt,
        mode: promptMode,
      };

      try {
        if (outputTarget === "chat_attachment") {
          message = chatsSvc.createMessage(chatId, {
            is_user: false,
            name: "ImageGen",
            content: "",
            extra: {
              image_gen: imageGenMeta,
              attachments: [newAttachment],
            },
          }, userId);
        } else if (outputTarget === "attach_to_message") {
          if (!opts?.attachToMessageId) {
            throw new Error("attachToMessageId is required for the attach_to_message output target");
          }
          // Lighter path than updateMessage: 1 read + 1 update + 1 emit, no
          // chat-memory cache invalidation, no second read-back.
          const updated = chatsSvc.appendMessageAttachment(
            userId,
            opts.attachToMessageId,
            newAttachment,
            { image_gen: imageGenMeta },
          );
          if (!updated) {
            throw new Error("Target message for image attachment was not found");
          }
          message = updated;
        }
      } catch (err) {
        // Image is already saved to our DB and (for streaming providers) sits
        // in the provider's history — surface the failure so the user sees
        // why nothing landed in chat instead of silently dropping it.
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[image-gen] Failed to attach generated image to chat:", err);
        eventBus.emit(
          EventType.IMAGE_GEN_ERROR,
          { assetId: jobId, chatId, message: `Image generated but chat attachment failed: ${detail}` },
          userId,
        );
        throw err;
      }

      // Gallery linkage is best-effort and not on the response's critical
      // path — defer to a microtask so the HTTP response (and the chat
      // re-render that follows from MESSAGE_EDITED) lands sooner.
      if (settings.addToGallery !== false) {
        const characterId = chatsSvc.getChat(userId, chatId)?.character_id;
        if (characterId) {
          queueMicrotask(() => {
            try {
              gallerySvc.linkImageToGallery(userId, characterId, image.id, "Generated image");
            } catch (err) {
              console.warn("[image-gen] Gallery linkage failed (non-fatal):", err);
            }
          });
        }
      }
    }

    if (promptResult.scene) sceneCacheSet(cacheKey, promptResult.scene);

    eventBus.emit(EventType.IMAGE_GEN_COMPLETE, { assetId: jobId, chatId, imageId, imageUrl }, userId);

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
      jobId,
    };
  } finally {
    // Only clear the registry entry if it still points at our controller —
    // a newer request may have already overwritten it.
    if (activeImageGenerations.get(registryKey)?.controller === controller) {
      activeImageGenerations.delete(registryKey);
    }
  }
}

/**
 * Runs a provider generation, preferring its streaming generator (Comfy/Swarm)
 * so we can broadcast IMAGE_GEN_PROGRESS events as steps and previews arrive.
 * Falls back to the plain `generate()` call for providers without streaming.
 */
async function runProviderGeneration(
  provider: ReturnType<typeof getImageProvider>,
  apiKey: string,
  apiUrl: string,
  request: ImageGenRequest,
  ctx: { jobId: string; chatId: string; userId: string },
): Promise<import("../image-gen/types").ImageGenResponse> {
  if (!provider) throw new Error("Image provider not available");

  // generateStream is optional on the ImageProvider interface; only Comfy/Swarm
  // implement it today.
  const stream = (provider as any).generateStream;
  if (typeof stream === "function") {
    const iter = stream.call(provider, apiKey, apiUrl, request) as AsyncGenerator<
      { step?: number; totalSteps?: number; preview?: string; nodeId?: string },
      import("../image-gen/types").ImageGenResponse,
      unknown
    >;
    let lastStep = 0;
    let lastTotal = 0;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        return next.value;
      }
      const chunk = next.value;
      if (typeof chunk.step === "number") lastStep = chunk.step;
      if (typeof chunk.totalSteps === "number") lastTotal = chunk.totalSteps;
      eventBus.emit(
        EventType.IMAGE_GEN_PROGRESS,
        {
          assetId: ctx.jobId,
          chatId: ctx.chatId,
          step: typeof chunk.step === "number" ? chunk.step : lastStep,
          totalSteps: typeof chunk.totalSteps === "number" ? chunk.totalSteps : lastTotal,
          preview: chunk.preview,
          nodeId: chunk.nodeId,
        },
        ctx.userId,
      );
    }
  }

  return provider.generate(apiKey, apiUrl, request);
}

/**
 * Runs the prompt-resolution half of the pipeline (settings → preset → optional
 * parser LLM call) without sending anything to the image provider. Used by the
 * "Preview prompt before generating" flow so the user can edit the assembled
 * prompt before committing to a generation.
 */
export async function previewImagePrompt(
  userId: string,
  chatId: string,
  opts?: Omit<GenerateImageOptions, "outputTarget" | "attachToMessageId" | "skipParse" | "clientJobId" | "generationTimeoutSeconds" | "forceGeneration">,
): Promise<{ prompt: string; negativePrompt?: string; scene?: SceneData; provider: string }> {
  let settings = getImageGenSettings(userId);
  await maybeAutoMigrate(userId, settings);
  settings = getImageGenSettings(userId);

  const connectionId = settings.activeImageGenConnectionId;
  if (!connectionId) {
    throw new Error("No image generation connection selected. Create one in Settings → Image Gen Connections.");
  }
  const connection = imageGenConnSvc.getConnection(userId, connectionId);
  if (!connection) throw new Error("Image generation connection not found");

  const params = { ...connection.default_parameters };
  const promptInput = await resolvePromptInput(userId, chatId, settings, opts);
  const promptMode = opts?.promptMode || settings.promptMode || "scene";
  const promptTimeoutSecs = resolveTimeoutSeconds(opts?.promptGenerationTimeoutSeconds, settings.promptGenerationTimeoutSeconds ?? 60);

  const controller = new AbortController();
  const promptSignal = createPhaseTimeoutSignal(
    controller.signal,
    promptTimeoutSecs,
    `Image prompt generation timed out after ${promptTimeoutSecs}s`,
  );
  try {
    const promptResult = await resolveImagePrompt(
      userId,
      chatId,
      settings,
      promptMode,
      promptInput,
      params,
      connection.provider,
      promptSignal.signal,
    );
    return {
      prompt: promptResult.prompt,
      negativePrompt: promptResult.negativePrompt,
      scene: promptResult.scene,
      provider: connection.provider,
    };
  } catch (err) {
    throw resolveAbortReason(promptSignal.signal) ?? err;
  } finally {
    promptSignal.cleanup();
  }
}

export interface CaptionImageInput {
  image: string;
  mimeType: string;
  prompt?: string;
  presetId?: string | null;
  parserConnectionId?: string | null;
  parserModel?: string;
  parserParameters?: Record<string, any>;
  timeoutSeconds?: number;
}

export async function captionImage(
  userId: string,
  input: CaptionImageInput,
): Promise<{ caption: string }> {
  const settings = getImageGenSettings(userId);

  const promptText =
    input.prompt?.trim() ||
    (input.presetId
      ? (settings.promptPresets || []).find((p) => p.id === input.presetId)?.prompt
      : undefined) ||
    "Describe this image in detail using concise image-generation tags. Include subject, composition, style, lighting, mood, and colors.";

  const parser = await resolvePromptParser(userId, settings, {
    id: "",
    name: "",
    mode: "parsed_custom",
    prompt: "",
    parserConnectionId: input.parserConnectionId || null,
    parserModel: input.parserModel || "",
    parserParameters: input.parserParameters || {},
  });

  const timeoutSecs = resolveTimeoutSeconds(input.timeoutSeconds, settings.promptGenerationTimeoutSeconds ?? 60);
  const controller = new AbortController();
  const timeout = createPhaseTimeoutSignal(
    controller.signal,
    timeoutSecs,
    `Image captioning timed out after ${timeoutSecs}s`,
  );

  try {
    const response = await rawGenerate(userId, {
      provider: parser.connection.provider,
      model: parser.model,
      connection_id: parser.connection.id,
      messages: [
        {
          role: "system",
          content:
            "You are an image analyst producing concise, detailed descriptions suitable for image generation prompts. Follow the user's instructions for style and format. Return only the caption text, no markdown fences or JSON.",
        },
        {
          role: "user",
          content: [
            { type: "image", data: input.image, mime_type: input.mimeType },
            { type: "text", text: promptText },
          ],
        },
      ],
      parameters: parser.parameters,
      signal: timeout.signal,
    });
    return { caption: (response.content || "").trim() };
  } catch (err) {
    throw resolveAbortReason(timeout.signal) ?? err;
  } finally {
    timeout.cleanup();
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
  characterLora?: characterLoraSvc.CharacterLoraBinding | null,
  apiKey?: string,
): Promise<void> {
  if (params.workflow && typeof params.workflow === "object") return;

  const config = readComfyUIConfig(connection.metadata);
  if (!config) return;

  const mappings = config.field_mappings || [];
  const hasPositivePrompt = mappings.some((mapping) => mapping.mappedAs === "positive_prompt");
  if (!hasPositivePrompt) {
    throw new Error("Imported ComfyUI workflow must map at least one positive prompt field");
  }

  const target = resolveComfyTarget(connection, apiKey);
  const objectInfo = await getComfyUIObjectInfo(target.baseUrl, false, { cookie: target.cookie });
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

  if (characterLora) {
    patchValues.lora_name = characterLora.lora_name;
    patchValues.lora_strength_model = characterLora.weight_model;
    patchValues.lora_strength_clip = characterLora.weight_clip;
  }

  const extraFieldValues = params.comfyui_field_values;
  if (extraFieldValues && typeof extraFieldValues === "object") {
    Object.assign(patchValues, extraFieldValues);
  }
  patchValues.seed = resolveComfySeedParam(patchValues.seed ?? params.seed);

  // img2img: only engage when the workflow actually maps an init_image field
  // (i.e. it's an img2img graph). This keeps the denoise param from clobbering
  // the KSampler denoise of a plain txt2img workflow, whose `denoise` field may
  // be auto-detected as a mapping but must stay at its embedded value (1.0).
  const hasInitImageMapping = mappings.some((mapping) => mapping.mappedAs === "init_image");
  if (hasInitImageMapping) {
    if (patchValues.denoise === undefined) patchValues.denoise = numberParam(params.denoise);

    // Upload the resolved source image and inject the returned filename. A
    // mapping without a configured source image is a no-op (the workflow keeps
    // its embedded LoadImage default).
    const sourceImage = Array.isArray(params.resolvedSourceImages)
      ? params.resolvedSourceImages[0]
      : undefined;
    if (sourceImage?.data && patchValues.init_image === undefined) {
      const uploaded = await uploadComfyImage(
        target.baseUrl,
        { data: sourceImage.data, mimeType: sourceImage.mimeType },
        { cookie: target.cookie },
      );
      patchValues.init_image = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    }
  }

  params.workflow = patchWorkflow(normalizedWorkflow.apiWorkflow, mappings, patchValues);
  params.workflowFormat = "api_prompt";
  params.preserveImportedWorkflow = true;
}

function resolveCharacterLoraForChat(
  userId: string,
  chatId: string,
): characterLoraSvc.CharacterLoraBinding | null {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat?.character_id) return null;
  return characterLoraSvc.getCharacterLora(userId, chat.character_id);
}

/**
 * Prepend per-character anchor tags to the assembled prompt. Tags toward the
 * front carry the most weight in tag-style prompts (Booru/SD), so character
 * identity stays stable across scene variation.
 */
function composeWithBaseTags(baseTags: string, prompt: string): string {
  const trimmedTags = baseTags.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedTags) return prompt;
  if (!trimmedPrompt) return trimmedTags;
  return `${trimmedTags}, ${trimmedPrompt}`;
}

/**
 * Wire the per-character LoRA into provider-specific parameter slots.
 * ComfyUI consumes them via patchWorkflow later in the pipeline; SwarmUI
 * gets `loras` + `loraWeights` body params. Other providers ignore the
 * binding (base tags still apply via the prompt prepend).
 *
 * Honors user-supplied values: if the connection's default_parameters already
 * specify a LoRA (e.g. for a non-character image gen), the character binding
 * is layered on top via comma-joined parameter strings — SwarmUI accepts
 * multi-LoRA via parallel comma-separated lists.
 */
function applyCharacterLoraToParams(
  provider: string,
  params: Record<string, any>,
  binding: characterLoraSvc.CharacterLoraBinding,
): void {
  if (provider === "swarmui") {
    const existingNames = stringParam(params.loras);
    const existingWeights = stringParam(params.loraWeights);
    params.loras = existingNames ? `${existingNames},${binding.lora_name}` : binding.lora_name;
    // SwarmUI requires parallel lists; we use weight_model as the SwarmUI
    // weight (it has a single strength field, not separate model/clip).
    params.loraWeights = existingWeights
      ? `${existingWeights},${binding.weight_model}`
      : String(binding.weight_model);
    return;
  }
  // ComfyUI is handled by applyComfyUIWorkflowConfig which reads the binding
  // directly. Other providers don't have a LoRA story to wire into.
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

async function resolvePromptInput(
  userId: string,
  chatId: string,
  settings: ImageGenSettings,
  opts?: GenerateImageOptions,
): Promise<ImageGenPromptPreset> {
  const presets = settings.promptPresets || [];
  const preset = presets.find((p) => p.id === (opts?.promptPresetId || settings.activePromptPresetId));
  const requestedMode = opts?.skipParse
    ? "custom"
    : opts?.promptMode || preset?.mode || settings.promptMode || "custom";

  let prompt = opts?.prompt ?? preset?.prompt ?? settings.customPrompt ?? "";
  let negativePrompt = opts?.negativePrompt ?? preset?.negativePrompt ?? settings.customNegativePrompt ?? "";

  // Skip character/persona splice when the caller passes a pre-resolved prompt
  // (e.g. coming back from the preview modal). Standard macros still run below
  // so {{user}}/{{char}} in the edited text are expanded.
  if (!opts?.skipParse) {
    const { prompt: expanded, negativePrompt: expandedNeg } = expandCharacterPromptMacro(
      userId,
      chatId,
      presets,
      prompt,
      negativePrompt,
    );
    prompt = expanded;
    negativePrompt = expandedNeg;
  }

  // Run the full macro engine last so the standard macro vocabulary —
  // {{user}}, {{char}}, {{group}}, temporal/string helpers, etc. — works
  // inside image-gen prompts (and inside any spliced character/persona text).
  // Best-effort: failure here must not block generation.
  if (prompt || negativePrompt) {
    try {
      const env = buildMacroEnvForChat(userId, chatId);
      if (env) {
        if (prompt) prompt = (await evaluateMacros(prompt, env, macroRegistry)).text;
        if (negativePrompt) negativePrompt = (await evaluateMacros(negativePrompt, env, macroRegistry)).text;
      }
    } catch {
      // Macros are a convenience; leave the raw text in place on failure.
    }
  }

  return {
    id: preset?.id || "inline",
    name: preset?.name || "Inline prompt",
    mode: requestedMode === "parsed_custom" ? "parsed_custom" : "custom",
    prompt,
    negativePrompt,
    parserConnectionId: settings.promptParserConnectionId ?? preset?.parserConnectionId ?? null,
    parserModel: settings.promptParserModel ?? preset?.parserModel ?? "",
    parserParameters: settings.promptParserParameters ?? preset?.parserParameters ?? {},
  };
}

/**
 * Pure substitution helper — replaces {{character_prompt}} and
 * {{character_negative_prompt}} placeholders with the bound character preset's
 * text. Empty bound text removes the placeholder entirely. Exported for
 * focused unit tests.
 */
export function substituteCharacterPromptMacro(
  prompt: string,
  negativePrompt: string,
  characterPrompt: string,
  characterNegativePrompt: string,
): { prompt: string; negativePrompt: string } {
  return {
    prompt: prompt.replace(/\{\{\s*character_prompt\s*\}\}/gi, characterPrompt),
    negativePrompt: negativePrompt.replace(/\{\{\s*character_negative_prompt\s*\}\}/gi, characterNegativePrompt),
  };
}

/**
 * Pure substitution helper for the persona macro — symmetric counterpart to
 * substituteCharacterPromptMacro. Exported for unit tests.
 */
export function substitutePersonaPromptMacro(
  prompt: string,
  negativePrompt: string,
  personaPrompt: string,
  personaNegativePrompt: string,
): { prompt: string; negativePrompt: string } {
  return {
    prompt: prompt.replace(/\{\{\s*persona_prompt\s*\}\}/gi, personaPrompt),
    negativePrompt: negativePrompt.replace(/\{\{\s*persona_negative_prompt\s*\}\}/gi, personaNegativePrompt),
  };
}

/**
 * Looks up the active persona for a chat. Prefers the persona referenced by
 * the most recent user message's `extra.persona_id`, then falls back to the
 * user's default persona. Returns null if neither is available.
 */
function resolveActivePersonaId(userId: string, chatId: string): string | null {
  const messages = chatsSvc.getMessages(userId, chatId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const pid = m?.is_user && (m.extra as any)?.persona_id;
    if (typeof pid === "string" && pid) return pid;
  }
  const def = personasSvc.getDefaultPersona(userId);
  return def?.id ?? null;
}

/**
 * Resolves bound character and persona presets for the active chat context
 * and threads them through `{{character_prompt}}` / `{{persona_prompt}}`
 * placeholders in the main preset text. The two are independent — having one
 * binding does not affect the other.
 */
function expandCharacterPromptMacro(
  userId: string,
  chatId: string,
  presets: ImageGenPromptPreset[],
  prompt: string,
  negativePrompt: string,
): { prompt: string; negativePrompt: string } {
  const hasCharMacro = /\{\{\s*character_prompt\s*\}\}/i.test(prompt)
    || /\{\{\s*character_negative_prompt\s*\}\}/i.test(negativePrompt);
  const hasPersonaMacro = /\{\{\s*persona_prompt\s*\}\}/i.test(prompt)
    || /\{\{\s*persona_negative_prompt\s*\}\}/i.test(negativePrompt);
  if (!hasCharMacro && !hasPersonaMacro) return { prompt, negativePrompt };

  let out = { prompt, negativePrompt };

  if (hasCharMacro) {
    const chat = chatsSvc.getChat(userId, chatId);
    let charPrompt = "";
    let charNegative = "";
    if (chat?.character_id) {
      const binding = imageGenBindingsSvc.getCharacterBinding(userId, chat.character_id);
      if (binding) {
        const bound = presets.find((p) => p.id === binding.preset_id && p.kind === "character");
        if (bound) {
          charPrompt = bound.prompt || "";
          charNegative = bound.negativePrompt || "";
        }
      }
    }
    out = substituteCharacterPromptMacro(out.prompt, out.negativePrompt, charPrompt, charNegative);
  }

  if (hasPersonaMacro) {
    const personaId = resolveActivePersonaId(userId, chatId);
    let personaPrompt = "";
    let personaNegative = "";
    if (personaId) {
      const binding = imageGenBindingsSvc.getPersonaBinding(userId, personaId);
      if (binding) {
        const bound = presets.find((p) => p.id === binding.preset_id && p.kind === "persona");
        if (bound) {
          personaPrompt = bound.prompt || "";
          personaNegative = bound.negativePrompt || "";
        }
      }
    }
    out = substitutePersonaPromptMacro(out.prompt, out.negativePrompt, personaPrompt, personaNegative);
  }

  return out;
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
        content: CUSTOM_PROMPT_PARSER_SYSTEM,
      },
      ...buildContextMessages(userId, chatId, settings),
      {
        role: "user",
        content: `Parser instructions from the user:\n${input.prompt}\n\nReturn the final image prompt now.`,
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
        content: `${tool.prompt}${settings.includeCharacters ? `\n\n${CHARACTER_AWARE_SCENE_INSTRUCTIONS}` : ""}\n\nYou must return ONLY valid JSON with the requested schema keys and no markdown fences.`,
      },
      ...buildContextMessages(userId, chatId, settings),
      { role: "user", content: "Return scene JSON now." },
    ],
    parameters: {
      ...parser.parameters,
    },
    signal,
  });

  return parseSceneJson(response.content || "");
}

function buildContextMessages(userId: string, chatId: string, settings: ImageGenSettings): LlmMessage[] {
  const includeCharacters = settings.includeCharacters;
  const msgs: LlmMessage[] = [];
  const chat = chatsSvc.getChat(userId, chatId);
  if (chat) {
    const char = chat.character_id ? charactersSvc.getCharacter(userId, chat.character_id) : null;
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
  if (includeCharacters) {
    const persona = personasSvc.resolvePersonaOrDefault(userId);
    if (persona) {
      const personaInfo = [
        persona.name && `Name: ${persona.name}`,
        persona.title && `Title: ${persona.title}`,
        persona.description && `Description: ${persona.description}`,
        (persona.subjective_pronoun || persona.objective_pronoun || persona.possessive_pronoun) &&
          `Pronouns: ${[persona.subjective_pronoun, persona.objective_pronoun, persona.possessive_pronoun].filter(Boolean).join("/")}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (personaInfo) msgs.push({ role: "system", content: `## User Persona\n${personaInfo}` });
    }
  }
  for (const m of chatsSvc.getMessages(userId, chatId).slice(-resolveContextMessageLimit(settings))) {
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
  const scene: SceneData = {
    environment: String(parsed.environment || "A neutral establishing shot"),
    time_of_day: String(parsed.time_of_day || "night"),
    weather: String(parsed.weather || "clear"),
    mood: String(parsed.mood || "neutral"),
    focal_detail: String(parsed.focal_detail || "the central environment"),
    palette_override: parsed.palette_override ? String(parsed.palette_override) : undefined,
    scene_changed: Boolean(parsed.scene_changed),
  };
  if (parsed.character_names) scene.character_names = String(parsed.character_names);
  if (Array.isArray(parsed.character_appearances)) {
    scene.character_appearances = parsed.character_appearances
      .filter((entry: any) => entry && typeof entry === "object")
      .map((entry: any) => ({
        name: entry.name ? String(entry.name) : undefined,
        role: entry.role ? String(entry.role) : undefined,
        appearance: entry.appearance ? String(entry.appearance) : undefined,
        tags: entry.tags ? String(entry.tags) : undefined,
      }));
  }
  if (parsed.composition_subjects) scene.composition_subjects = String(parsed.composition_subjects);
  if (parsed.composition_shot) scene.composition_shot = String(parsed.composition_shot);
  if (parsed.composition_camera) scene.composition_camera = String(parsed.composition_camera);
  if (Array.isArray(parsed.composition_rating)) scene.composition_rating = parsed.composition_rating.map((v: any) => String(v));
  return scene;
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
  if (includeCharacters) {
    if (scene.character_names) prompt += ` Characters: ${scene.character_names}.`;
    if (Array.isArray(scene.character_appearances) && scene.character_appearances.length > 0) {
      const appearances = scene.character_appearances
        .map((c) => [c.name, c.role, c.appearance, c.tags].filter(Boolean).join(" - "))
        .filter(Boolean)
        .join("; ");
      if (appearances) prompt += ` Character details: ${appearances}.`;
    }
    if (scene.composition_subjects) prompt += ` Composition: ${scene.composition_subjects}.`;
    if (scene.composition_shot) prompt += ` Framing: ${scene.composition_shot}.`;
    if (scene.composition_camera) prompt += ` Camera: ${scene.composition_camera}.`;
  } else {
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

  // Character + persona avatars (shared loader)
  for (const avatar of await loadConfiguredAvatarImages(userId, chatId, params)) {
    images.push({ data: avatar.data, strength, infoExtracted, refType: avatarRefType });
  }

  return images;
}

/**
 * Load the character and/or persona avatars selected via the
 * `includeCharacterAvatar` / `includePersonaAvatar` params as raw-base64
 * `{ data, mimeType }` images. Shared by NovelAI's director-reference flow and
 * the generic img2img source resolver below.
 */
async function loadConfiguredAvatarImages(
  userId: string,
  chatId: string,
  params: Record<string, any>,
): Promise<Array<{ data: string; mimeType: string }>> {
  const out: Array<{ data: string; mimeType: string }> = [];

  const loadById = async (imageId: string) => {
    const path = await imagesSvc.getImageFilePath(userId, imageId);
    if (!path) return;
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const mimeType = imagesSvc.getImage(userId, imageId)?.mime_type || "image/png";
    out.push({ data: uint8ToBase64(bytes), mimeType });
  };

  if (params.includeCharacterAvatar) {
    const chat = chatsSvc.getChat(userId, chatId);
    const character = chat?.character_id ? charactersSvc.getCharacter(userId, chat.character_id) : null;
    if (character?.image_id) await loadById(character.image_id);
  }

  if (params.includePersonaAvatar) {
    const personas = personasSvc.listPersonas(userId, { limit: 100, offset: 0 }).data;
    const persona = personas.find((p) => p.is_default) || personas[0];
    if (persona?.image_id) await loadById(persona.image_id);
  }

  return out;
}

/**
 * Resolve the shared img2img source image set for providers that accept image
 * input (SwarmUI, ComfyUI, Gemini). Reuses the same config surface as the
 * reference-image feature: manually uploaded `referenceImages` first, then any
 * selected character/persona avatars. Returns raw-base64 `{ data, mimeType }`.
 */
async function resolveSourceImages(
  userId: string,
  chatId: string,
  params: Record<string, any>,
): Promise<Array<{ data: string; mimeType: string }>> {
  const images: Array<{ data: string; mimeType: string }> = [];

  for (const ref of params.referenceImages || []) {
    if (ref?.data) images.push({ data: ref.data, mimeType: ref.mimeType || "image/png" });
  }

  images.push(...(await loadConfiguredAvatarImages(userId, chatId, params)));

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

// --- Import / Export ---

export const IMAGE_GEN_EXPORT_TYPE = "lumiverse_image_gen_config";
const IMAGE_GEN_EXPORT_VERSION = 1;

/**
 * Settings keys that travel in an export, with the value type expected on
 * import. Install-specific fields never transfer: the `enabled` flag (don't
 * silently toggle the feature on the receiving install), connection ID
 * references (meaningless on another install), the legacy provider blobs, and
 * the parser model/parameters (model IDs depend on the importer's parser
 * connection, so the importer keeps their own parser setup).
 */
const TRANSFERABLE_SETTING_TYPES: Record<string, "boolean" | "number" | "string" | "object"> = {
  includeCharacters: "boolean",
  promptMode: "string",
  customPrompt: "string",
  customNegativePrompt: "string",
  outputTarget: "string",
  previewPromptBeforeGenerate: "boolean",
  sceneChangeThreshold: "number",
  autoGenerate: "boolean",
  forceGeneration: "boolean",
  recycleGeneratedImages: "boolean",
  recycledImageLimit: "number",
  addToGallery: "boolean",
  backgroundOpacity: "number",
  fadeTransitionMs: "number",
  promptGenerationTimeoutSeconds: "number",
  generationTimeoutSeconds: "number",
  promptContextMessageLimit: "number",
};

const PROMPT_MODES: ImageGenPromptMode[] = ["scene", "custom", "parsed_custom"];
const OUTPUT_TARGETS: ImageGenOutputTarget[] = ["background", "chat_attachment", "preview", "attach_to_message"];
const PRESET_KINDS: ImageGenPresetKind[] = ["main", "character", "persona", "captioning"];

export interface ImageGenConnectionExport {
  name: string;
  provider: string;
  api_url: string;
  model: string;
  default_parameters: Record<string, any>;
  metadata: Record<string, any>;
}

export interface ImageGenConfigExport {
  version: number;
  type: typeof IMAGE_GEN_EXPORT_TYPE;
  exported_at: number;
  settings?: Partial<ImageGenSettings>;
  presets?: ImageGenPromptPreset[];
  connections?: ImageGenConnectionExport[];
  /** Generation parameters (steps, cfg, size, seed, …) of the active connection. */
  generation_parameters?: { provider: string; parameters: Record<string, any> };
}

export interface ImageGenConfigExportOptions {
  includeSettings?: boolean;
  includePresets?: boolean;
  includeConnections?: boolean;
  includeParameters?: boolean;
  presetIds?: string[];
  connectionIds?: string[];
}

export function exportImageGenConfig(
  userId: string,
  options?: ImageGenConfigExportOptions,
): ImageGenConfigExport {
  const settings = getImageGenSettings(userId);
  const out: ImageGenConfigExport = {
    version: IMAGE_GEN_EXPORT_VERSION,
    type: IMAGE_GEN_EXPORT_TYPE,
    exported_at: Math.floor(Date.now() / 1000),
  };

  if (options?.includePresets !== false) {
    let presets = settings.promptPresets || [];
    // A provided ID list is authoritative — an explicit empty selection
    // exports no presets rather than falling back to all of them.
    if (options?.presetIds) {
      const wanted = new Set(options.presetIds);
      presets = presets.filter((p) => wanted.has(p.id));
    }
    // Parser connection IDs reference this install's LLM connections, and the
    // parser model/parameters only make sense relative to one — the importer
    // configures their own parser.
    out.presets = presets.map(({ parserConnectionId, parserModel, parserParameters, ...rest }) => rest);
  }

  if (options?.includeSettings !== false) {
    const transferable: Partial<ImageGenSettings> = {};
    for (const key of Object.keys(TRANSFERABLE_SETTING_TYPES)) {
      const value = (settings as any)[key];
      if (value !== undefined) (transferable as any)[key] = value;
    }
    // The active preset reference only travels alongside the preset itself.
    if (settings.activePromptPresetId && out.presets?.some((p) => p.id === settings.activePromptPresetId)) {
      transferable.activePromptPresetId = settings.activePromptPresetId;
    }
    out.settings = transferable;
  }

  if (options?.includeConnections !== false) {
    let connections = imageGenConnSvc.listConnections(userId, { limit: 1000, offset: 0 }).data;
    if (options?.connectionIds) {
      const wanted = new Set(options.connectionIds);
      connections = connections.filter((c) => wanted.has(c.id));
    }
    out.connections = connections.map(sanitizeConnectionForExport);
  }

  if (options?.includeParameters !== false) {
    const activeId = settings.activeImageGenConnectionId;
    const active = activeId ? imageGenConnSvc.getConnection(userId, activeId) : null;
    if (active) {
      out.generation_parameters = {
        provider: active.provider,
        parameters: sanitizeGenerationParameters(active.default_parameters),
      };
    }
  }

  return out;
}

/**
 * Strips personal base64 image payloads (reference/source images) from a
 * generation parameter bag. Everything else — steps, cfg, size, seed,
 * sampler, etc. — travels.
 */
function sanitizeGenerationParameters(parameters: Record<string, any>): Record<string, any> {
  const { referenceImages, resolvedSourceImages, resolvedReferenceImages, ...params } =
    parameters || {};
  return params;
}

function sanitizeConnectionForExport(conn: ImageGenConnectionProfile): ImageGenConnectionExport {
  // API keys live in the encrypted secrets store and never appear on the row.
  return {
    name: conn.name,
    provider: conn.provider,
    api_url: conn.api_url,
    model: conn.model,
    default_parameters: sanitizeGenerationParameters(conn.default_parameters),
    metadata: conn.metadata || {},
  };
}

export interface ImageGenConfigImportResult {
  settings: ImageGenSettings;
  imported: { settings: boolean; presets: number; connections: number; parameters: boolean };
  errors: string[];
}

/**
 * Merges an exported config into the user's image gen setup. Presets are
 * matched by ID — re-importing an updated export overwrites the preset in
 * place, which keeps existing character/persona bindings intact. Connections
 * are always created fresh (without API keys — the user supplies their own).
 */
export async function importImageGenConfig(
  userId: string,
  payload: any,
): Promise<ImageGenConfigImportResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid import payload");
  }
  if (payload.type !== IMAGE_GEN_EXPORT_TYPE) {
    throw new Error("Not a Lumiverse image generation config export");
  }
  if (Number(payload.version) > IMAGE_GEN_EXPORT_VERSION) {
    throw new Error(`Unsupported export version ${payload.version}`);
  }

  const errors: string[] = [];
  const current = getImageGenSettings(userId);
  const presets = [...(current.promptPresets || [])];

  let importedPresets = 0;
  if (Array.isArray(payload.presets)) {
    payload.presets.forEach((entry: any, index: number) => {
      const preset = sanitizePresetForImport(entry, index, errors);
      if (!preset) return;
      const existing = presets.findIndex((p) => p.id === preset.id);
      if (existing >= 0) {
        // Overwrite the shared content but keep the parser setup the importer
        // configured locally on this preset.
        const local = presets[existing];
        presets[existing] = {
          ...preset,
          parserConnectionId: local.parserConnectionId,
          parserModel: local.parserModel,
          parserParameters: local.parserParameters,
        };
      } else {
        presets.push(preset);
      }
      importedPresets++;
    });
  }

  const next: ImageGenSettings = { ...current, promptPresets: presets };
  let importedSettings = false;
  if (payload.settings && typeof payload.settings === "object" && !Array.isArray(payload.settings)) {
    for (const [key, type] of Object.entries(TRANSFERABLE_SETTING_TYPES)) {
      const value = payload.settings[key];
      if (value === undefined || value === null) continue;
      if (!isTransferableValue(key, type, value)) {
        errors.push(`Setting "${key}" has an unexpected value and was skipped`);
        continue;
      }
      (next as any)[key] = value;
      importedSettings = true;
    }
    const activeId = payload.settings.activePromptPresetId;
    if (typeof activeId === "string" && presets.some((p) => p.id === activeId && (p.kind ?? "main") === "main")) {
      next.activePromptPresetId = activeId;
      importedSettings = true;
    }
  }

  if (importedSettings || importedPresets > 0) {
    settingsSvc.putSetting(userId, IMAGE_SETTINGS_KEY, next);
  }

  let importedConnections = 0;
  if (Array.isArray(payload.connections)) {
    for (let i = 0; i < payload.connections.length; i++) {
      const entry = payload.connections[i];
      const provider = typeof entry?.provider === "string" ? entry.provider : "";
      if (!provider || !getImageProvider(provider)) {
        errors.push(`Connection ${i}: unknown provider "${provider || "(missing)"}"`);
        continue;
      }
      await imageGenConnSvc.createConnection(userId, {
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Imported ${provider}`,
        provider,
        api_url: typeof entry.api_url === "string" ? entry.api_url : "",
        model: typeof entry.model === "string" ? entry.model : "",
        default_parameters:
          entry.default_parameters && typeof entry.default_parameters === "object" && !Array.isArray(entry.default_parameters)
            ? entry.default_parameters
            : {},
        metadata:
          entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
            ? entry.metadata
            : {},
      });
      importedConnections++;
    }
  }

  // Generation parameters apply to the importer's active connection so a
  // preset share carries its steps/cfg/size recipe. Skipped on provider
  // mismatch — NovelAI samplers mean nothing to a ComfyUI workflow.
  let importedParameters = false;
  const generationParams = payload.generation_parameters;
  if (generationParams && typeof generationParams === "object" && !Array.isArray(generationParams)) {
    const provider = typeof generationParams.provider === "string" ? generationParams.provider : "";
    const parameters =
      generationParams.parameters && typeof generationParams.parameters === "object" && !Array.isArray(generationParams.parameters)
        ? generationParams.parameters
        : null;
    const activeId = current.activeImageGenConnectionId;
    const active = activeId ? imageGenConnSvc.getConnection(userId, activeId) : null;
    if (!parameters) {
      errors.push("Generation parameters entry is malformed and was skipped");
    } else if (!active) {
      // When the same payload ships full connections the parameters already
      // arrived inside them — only flag the gap for parameter-only imports.
      if (importedConnections === 0) {
        errors.push("Generation parameters skipped: no active image generation connection to apply them to");
      }
    } else if (provider && active.provider !== provider) {
      errors.push(
        `Generation parameters skipped: they target provider "${provider}" but the active connection uses "${active.provider}"`,
      );
    } else {
      await imageGenConnSvc.updateConnection(userId, active.id, {
        default_parameters: { ...active.default_parameters, ...sanitizeGenerationParameters(parameters) },
      });
      importedParameters = true;
    }
  }

  return {
    settings: getImageGenSettings(userId),
    imported: {
      settings: importedSettings,
      presets: importedPresets,
      connections: importedConnections,
      parameters: importedParameters,
    },
    errors,
  };
}

function isTransferableValue(key: string, type: string, value: unknown): boolean {
  if (key === "promptMode") return PROMPT_MODES.includes(value as ImageGenPromptMode);
  if (key === "outputTarget") return OUTPUT_TARGETS.includes(value as ImageGenOutputTarget);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sanitizePresetForImport(
  entry: any,
  index: number,
  errors: string[],
): ImageGenPromptPreset | null {
  if (!entry || typeof entry !== "object") {
    errors.push(`Preset ${index}: not an object`);
    return null;
  }
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) {
    errors.push(`Preset ${index}: missing name`);
    return null;
  }
  // Parser connection/model/parameters never import — they're bound to the
  // importer's own parser connection profile.
  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
    name,
    mode: entry.mode === "parsed_custom" ? "parsed_custom" : "custom",
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    negativePrompt: typeof entry.negativePrompt === "string" ? entry.negativePrompt : undefined,
    kind: PRESET_KINDS.includes(entry.kind) ? entry.kind : "main",
  };
}
