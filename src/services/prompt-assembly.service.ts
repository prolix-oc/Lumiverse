import {
  getTextContent,
  type LlmMessage,
  type AssemblyContext,
  type AssemblyResult,
  type AssemblyBreakdownEntry,
  type GenerationType,
  type ActivatedWorldInfoEntry,
  type MemoryStats,
  type DatabankStats,
  type ContextClipStats,
} from "../llm/types";
import {
  resolveCounter,
  APPROXIMATE_TOKENIZER_NAME,
} from "./tokenizer.service";
import type {
  PromptBlock,
  PromptBehavior,
  CompletionSettings,
  SamplerOverrides,
  AuthorsNote,
  AdvancedSettings,
  PromptVariableDef,
  PromptVariableValue,
} from "../types/preset";
import type { WorldInfoCache } from "../types/world-book";
import type { Character } from "../types/character";
import { getEffectiveCharacterName } from "../types/character";
import type { Persona } from "../types/persona";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { Preset } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import {
  evaluate,
  buildEnv,
  resolveGroupCharacterNames,
  registry,
  initMacros,
} from "../macros";
import type { MacroEnv } from "../macros";
import {
  activateWorldInfo,
  finalizeActivatedWorldInfoEntries,
  type WiState,
  type WorldInfoSettings,
  type FinalizedWorldInfoEntries,
  DEFAULT_WORLD_INFO_SETTINGS,
} from "./world-info-activation.service";
import * as chatsSvc from "./chats.service";
import { stripReasoningTags } from "./chats.service";
import {
  stripDetailsBlocks as _stripDetailsBlocks,
  stripLoomTags as _stripLoomTags,
  stripHtmlFormattingTags as _stripHtmlFormattingTags,
  collapseExcessiveNewlines as _collapseExcessiveNewlines,
  sanitizeForVectorization,
  type SanitizeOptions,
} from "../utils/content-sanitizer";
import { healFormattingArtifacts } from "../utils/format-healing";
import {
  getReasoningStripOptions,
  hasReasoningDelimiters,
  resolveReasoningDelimiters,
} from "../utils/reasoning-strip";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as globalAddonsSvc from "./global-addons.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as worldBooksSvc from "./world-books.service";
import * as settingsSvc from "./settings.service";
import * as packsSvc from "./packs.service";
import * as embeddingsSvc from "./embeddings.service";
import { loadWorldBookVectorSettings } from "./world-book-vector-settings.service";
import * as imagesSvc from "./images.service";
import * as presetProfilesSvc from "./preset-profiles.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import { readCachedChatMemory } from "./chat-memory-cache.service";
import { deduplicateWorldInfoEntries } from "./world-info-dedup.service";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import * as memoryCortex from "./memory-cortex";
import { buildEmotionalContext } from "./memory-cortex";
import * as databankSvc from "./databank";
import { getCharacterDatabankIds } from "../utils/character-databanks";
import { getSidecarSettings } from "./sidecar-settings.service";
import { getChatBackgroundSignal } from "./chat-background.service";
import { getDreamWeaverRuntimeBlocks } from "./dream-weaver/runtime-prompt";

// ---------------------------------------------------------------------------
// Chat history identity marker
// ---------------------------------------------------------------------------
// Each LlmMessage that originates from the user's chat history (as opposed to
// system blocks, world info, author's note, depth-injected blocks, etc.) is
// tagged with this property. Downstream consumers (regex script depth filter,
// tokenizer breakdown snapshot) use the tag to identify chat history messages
// regardless of where they end up in the final assembled array, since later
// insertions/merges can shift positions and even break contiguity.
//
// The tag is preserved by every mutation that uses object spread
// (`{ ...result[i], content: ... }`). The merge function — which constructs
// new message objects without spreading — is updated to preserve the tag
// explicitly.
//
// Tag is a regular string property because Symbol-keyed props are not copied
// by spread. Providers explicitly destructure {role, content} when building
// outbound requests, so the tag never leaks to the LLM.

const CHAT_HISTORY_KEY = "__chatHistorySource";

function markAsChatHistory(msg: LlmMessage): LlmMessage {
  (msg as any)[CHAT_HISTORY_KEY] = true;
  return msg;
}

export function isChatHistoryMessage(msg: LlmMessage): boolean {
  return (msg as any)[CHAT_HISTORY_KEY] === true;
}

export function resolveChatHistoryInsertionIndex(
  messages: LlmMessage[],
  depth: number,
): number {
  const clampedDepth = Math.max(0, depth);
  const historyIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (isChatHistoryMessage(messages[i])) historyIndices.push(i);
  }

  if (historyIndices.length === 0) return messages.length;

  const offsetFromStart = Math.max(0, historyIndices.length - clampedDepth);
  if (offsetFromStart >= historyIndices.length) {
    return historyIndices[historyIndices.length - 1] + 1;
  }

  return historyIndices[offsetFromStart];
}

// ---------------------------------------------------------------------------
// Cooperative cancellation helper
// ---------------------------------------------------------------------------
// Assembly runs several synchronous CPU-bound phases (macro evaluation across
// 20+ blocks, Aho-Corasick keyword scanning, context-budget tokenization) that
// would otherwise monopolise the event loop on constrained runtimes (Termux,
// low-end mobile). Without periodic macrotask yields, a user's `/generate/stop`
// HTTP request queues behind the work and the stop button feels dead.
//
// `yieldAndCheckAbort` performs a setTimeout(0) macrotask yield so Bun's HTTP
// dispatcher can land a pending stop request on the AbortController, then
// checks the signal. Cheap: roughly one event-loop tick per call (~0ms on
// desktop, few-ms on Termux). Call at phase boundaries and inside tight loops.
async function yieldAndCheckAbort(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function normalizeWorldInfoOutletName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strip whitespace-only text parts from any multipart message. Strict providers
 * (Anthropic, some OpenAI-compat) reject text content blocks that contain only
 * whitespace; filtering at the assembly boundary keeps every downstream provider
 * safe without per-provider defensive code.
 *
 * If a multipart message ends up with zero parts after filtering (all text was
 * blank and no media survived), the message is collapsed to a string so the
 * outbound request at least carries an empty-but-valid content field.
 */
function stripEmptyTextParts(result: LlmMessage[]): void {
  let write = 0;
  for (let read = 0; read < result.length; read++) {
    const msg = result[read];

    if (typeof msg.content === "string") {
      if (msg.content.trim().length > 0) {
        result[write++] = msg;
      }
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result[write++] = msg;
      continue;
    }

    const parts = msg.content as import("../llm/types").LlmMessagePart[];
    const cleaned = parts.filter(
      (p) => p.type !== "text" || p.text.trim().length > 0,
    );

    if (cleaned.length === 0) {
      continue; // Drop the message entirely if it has no content left
    }

    if (cleaned.length === parts.length) {
      result[write++] = msg;
      continue;
    }

    const replacement: LlmMessage = { ...msg, content: cleaned };
    if (isChatHistoryMessage(msg)) markAsChatHistory(replacement);
    result[write++] = replacement;
  }
  result.length = write;
}

function rtrimLastHistoryAssistant(result: LlmMessage[]): void {
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "assistant" || !isChatHistoryMessage(msg)) continue;

    if (typeof msg.content === "string") {
      const trimmed = msg.content.replace(/\s+$/, "");
      if (trimmed !== msg.content) {
        result[i] = { ...msg, content: trimmed };
        markAsChatHistory(result[i]);
      }
    } else if (Array.isArray(msg.content)) {
      const parts = msg.content as import("../llm/types").LlmMessagePart[];
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j];
        if (p.type !== "text") continue;
        const trimmed = p.text.replace(/\s+$/, "");
        if (trimmed !== p.text) {
          const newParts = [...parts];
          newParts[j] = { type: "text", text: trimmed };
          result[i] = { ...msg, content: newParts };
          markAsChatHistory(result[i]);
        }
        break;
      }
    }
    return;
  }
}

function isDecorativeNewChatSeparator(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "[Start a new Chat]") return true;
  return /^\[Start a new group chat(?:\. Group members:.*)?\]$/i.test(trimmed);
}

const DEFAULT_EMPTY_SEND_NUDGE = "[Write the next reply only as {{char}}.]";

// ---------------------------------------------------------------------------
// Attachment resolution — read image/audio files from disk into base64
// ---------------------------------------------------------------------------

async function resolveAttachmentBase64(
  userId: string,
  imageId: string,
): Promise<string | null> {
  const filePath = await imagesSvc.getImageFilePath(userId, imageId);
  if (!filePath) return null;
  try {
    const buffer = await Bun.file(filePath).arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Alternate field resolution — per-chat variant overrides
// ---------------------------------------------------------------------------

const ALTERNATE_FIELD_NAMES = [
  "description",
  "personality",
  "scenario",
] as const;

/**
 * Resolves per-chat alternate field selections onto a character object.
 * Returns a shallow copy with overridden fields, or the original if no overrides apply.
 */
function resolveCharacterWithAlternateFields(
  character: Character,
  chat: Chat,
): Character {
  const selections = chat.metadata?.alternate_field_selections as
    | Record<string, string>
    | undefined;
  if (!selections) return character;

  const altFields = character.extensions?.alternate_fields as
    | Record<string, Array<{ id: string; label: string; content: string }>>
    | undefined;
  if (!altFields) return character;

  let hasOverride = false;
  const overrides: Record<string, string> = {};

  for (const field of ALTERNATE_FIELD_NAMES) {
    const variantId = selections[field];
    if (!variantId) continue;
    const variants = altFields[field];
    if (!Array.isArray(variants)) continue;
    const variant = variants.find((v) => v.id === variantId);
    if (variant) {
      overrides[field] = variant.content;
      hasOverride = true;
    }
  }

  return hasOverride ? { ...character, ...overrides } : character;
}

// ---------------------------------------------------------------------------
// Group scenario override — replace scenario with a group-level value
// ---------------------------------------------------------------------------

interface GroupScenarioOverride {
  mode: "individual" | "member" | "custom";
  member_character_id?: string;
  content?: string;
}

function resolveGroupScenarioOverride(
  character: Character,
  chat: Chat,
  userId: string,
): Character {
  const override = chat.metadata?.group_scenario_override as
    | GroupScenarioOverride
    | undefined;
  if (!override || override.mode === "individual") return character;

  if (override.mode === "member" && override.member_character_id) {
    const memberChar = charactersSvc.getCharacter(
      userId,
      override.member_character_id,
    );
    if (memberChar) {
      return { ...character, scenario: memberChar.scenario || "" };
    }
  }

  if (override.mode === "custom" && override.content !== undefined) {
    return { ...character, scenario: override.content };
  }

  return character;
}

// ---------------------------------------------------------------------------
// Structural / content marker sets (mirrors frontend loom/constants.ts)
// ---------------------------------------------------------------------------

const STRUCTURAL_MARKERS = new Set([
  "chat_history",
  "world_info_before",
  "world_info_after",
  "char_description",
  "char_personality",
  "persona_description",
  "scenario",
  "dialogue_examples",
]);

const CONTENT_BEARING_MARKERS = new Set([
  "main_prompt",
  "enhance_definitions",
  "jailbreak",
  "nsfw_prompt",
]);

/** Maps structural markers to the macro that resolves their content. */
const MARKER_TO_MACRO: Record<string, string> = {
  char_description: "{{description}}",
  char_personality: "{{personality}}",
  persona_description: "{{persona}}",
  scenario: "{{scenario}}",
  dialogue_examples: "{{mesExamples}}",
};

/** Sampler override camelCase → API snake_case mapping. */
const SAMPLER_KEY_MAP: Record<string, string> = {
  maxTokens: "max_tokens",
  contextSize: "max_context_length",
  temperature: "temperature",
  topP: "top_p",
  minP: "min_p",
  topK: "top_k",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
  repetitionPenalty: "repetition_penalty",
};

/**
 * Sampler keys where a value of 0 means "exclude from request".
 * This lets users disable individual samplers to avoid provider conflicts
 * (e.g. Claude rejects requests that set both temperature and top_p).
 * topK is intentionally excluded here: the Loom Builder exposes an explicit
 * include toggle for it, so users can choose between omitting `top_k` entirely
 * and intentionally sending `top_k: 0`.
 * maxTokens and contextSize are excluded — 0 is never a valid intent for those.
 */
const ZERO_EXCLUDES_SAMPLER = new Set([
  "temperature",
  "topP",
  "minP",
  "frequencyPenalty",
  "presencePenalty",
  "repetitionPenalty",
]);

/**
 * Default sampler values — mirrors the frontend's `defaultHint` from SAMPLER_PARAMS.
 * When samplerOverrides is enabled but a value is null, these are sent to ensure
 * generation behavior matches what the user sees in the UI sliders.
 *
 * Only includes params that should ALWAYS be sent when enabled. Opt-in params
 * (frequencyPenalty, presencePenalty, repetitionPenalty) are excluded — a null
 * value means the user hasn't opted in, so we don't send them.
 */
const SAMPLER_DEFAULTS: Record<string, number> = {
  maxTokens: 16384,
  temperature: 1.0,
  topP: 0.95,
};

interface GuidedGeneration {
  id: string;
  name: string;
  content: string;
  position: "system" | "user_prefix" | "user_suffix";
  mode: "persistent" | "oneshot";
  enabled: boolean;
}

function isAppendRole(role: string): boolean {
  return role === "user_append" || role === "assistant_append";
}

/**
 * Reorder non-marker blocks so their `position` field is respected relative
 * to the chat_history marker.  Blocks with position "post_history" (or
 * "in_history") that sit before the marker are moved to just after it, and
 * blocks with position "pre_history" that sit after the marker are moved to
 * just before it.  Marker blocks and append-role blocks are left in place.
 */
function reorderBlocksByPosition(blocks: PromptBlock[]): void {
  const chatHistoryIdx = blocks.findIndex((b) => b.marker === "chat_history");
  if (chatHistoryIdx < 0) return;

  // Identify misplaced content blocks
  const moveToAfter: Set<number> = new Set();
  const moveToBefore: Set<number> = new Set();

  for (let i = 0; i < blocks.length; i++) {
    if (i === chatHistoryIdx) continue;
    const b = blocks[i];
    if (b.marker || isAppendRole(b.role)) continue;

    if (
      i < chatHistoryIdx &&
      (b.position === "post_history" || b.position === "in_history")
    ) {
      moveToAfter.add(i);
    } else if (i > chatHistoryIdx && b.position === "pre_history") {
      moveToBefore.add(i);
    }
  }

  if (moveToAfter.size === 0 && moveToBefore.size === 0) return;

  // Rebuild: blocks before chat_history (minus those moving after)
  const result: PromptBlock[] = [];
  for (let i = 0; i < chatHistoryIdx; i++) {
    if (!moveToAfter.has(i)) result.push(blocks[i]);
  }
  // Pre-history blocks that were after chat_history (preserve their relative order)
  for (const idx of moveToBefore) result.push(blocks[idx]);
  // chat_history marker
  result.push(blocks[chatHistoryIdx]);
  // Post-history blocks that were before chat_history (preserve their relative order)
  for (const idx of moveToAfter) result.push(blocks[idx]);
  // Remaining blocks after chat_history (minus those moved before)
  for (let i = chatHistoryIdx + 1; i < blocks.length; i++) {
    if (!moveToBefore.has(i)) result.push(blocks[i]);
  }

  blocks.length = 0;
  blocks.push(...result);
}

function appendBaseRole(role: string): "user" | "assistant" {
  return role === "user_append" ? "user" : "assistant";
}

/**
 * Walk enabled prompt blocks, merge stored overrides over creator defaults,
 * coerce + clamp per variable type, and publish the result on env.extra so
 * {{var::name}} / {{hasVar::name}} / {{varDefault::name}} resolve consistently
 * across every block in the assembly.
 *
 * Policy: disabled blocks are skipped entirely — their variables aren't "in play"
 * for this generation. Values in preset.metadata.promptVariables persist so they
 * reappear on re-enable. On a variable-name collision across enabled blocks the
 * last block in prompt_order wins; the UI warns creators about shadowing.
 */
function resolvePromptVariables(
  env: MacroEnv,
  blocks: PromptBlock[],
  preset: Preset | null,
): void {
  const stored = (preset?.metadata?.promptVariables ?? {}) as Record<
    string,
    Record<string, PromptVariableValue>
  >;

  const values: Record<string, PromptVariableValue> = {};
  const defaults: Record<string, PromptVariableValue> = {};
  const byBlock: Record<string, Record<string, PromptVariableValue>> = {};

  for (const block of blocks) {
    if (!block.enabled || !block.variables?.length) continue;
    const bucket = stored[block.id] ?? {};
    const perBlock: Record<string, PromptVariableValue> = {};
    for (const def of block.variables) {
      if (!def?.name) continue;
      const override = Object.prototype.hasOwnProperty.call(bucket, def.name)
        ? bucket[def.name]
        : undefined;
      const resolved = coercePromptVariableValue(def, override);
      perBlock[def.name] = resolved;
      values[def.name] = resolved;
      defaults[def.name] = coercePromptVariableValue(def, undefined);
    }
    if (Object.keys(perBlock).length) byBlock[block.id] = perBlock;
  }

  env.extra.promptVariables = values;
  env.extra.promptVariablesByBlock = byBlock;
  env.extra.promptVariableDefaults = defaults;

  // Seed the local-variables Map so {{getvar::name}} resolves to the same
  // value as {{var::name}}. Seeding happens before any block renders, so
  // in-prompt {{setvar::name::…}} can still override mid-assembly (setvar
  // wins because it runs later during block evaluation).
  for (const [name, value] of Object.entries(values)) {
    if (!env.variables.local.has(name)) {
      env.variables.local.set(name, String(value));
    }
  }
}

function coercePromptVariableValue(
  def: PromptVariableDef,
  raw: unknown,
): PromptVariableValue {
  switch (def.type) {
    case "text":
    case "textarea": {
      if (raw === undefined || raw === null) return def.defaultValue ?? "";
      return String(raw);
    }
    case "number": {
      const fallback =
        typeof def.defaultValue === "number" ? def.defaultValue : 0;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      const v = Number.isFinite(n) ? n : fallback;
      return clampNumber(v, def.min, def.max);
    }
    case "slider": {
      const fallback =
        typeof def.defaultValue === "number" ? def.defaultValue : def.min;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      const v = Number.isFinite(n) ? n : fallback;
      return clampNumber(v, def.min, def.max);
    }
  }
}

function clampNumber(
  value: number,
  min: number | undefined,
  max: number | undefined,
): number {
  let v = value;
  if (typeof min === "number" && v < min) v = min;
  if (typeof max === "number" && v > max) v = max;
  return v;
}

interface PendingAppend {
  baseRole: "user" | "assistant";
  depth: number;
  content: string;
  blockName: string;
  blockId: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Assemble the full LLM prompt from the Loom preset, character data,
 * persona, world info, and chat history.
 *
 * Falls back to legacy simple message mapping if no preset/blocks are found.
 */
export async function assemblePrompt(
  ctx: AssemblyContext,
): Promise<AssemblyResult> {
  // Macrotask yield + abort check at the entry point so the event loop can
  // process pending HTTP requests (crucially `/generate/stop`) before we
  // enter the long stretch of synchronous block iteration, macro evaluation,
  // and regex script application below. Without this, a stop clicked during
  // the first ~200ms of assembly stayed queued behind our sync work and the
  // user perceived the stop button as unresponsive.
  await new Promise<void>((r) => setTimeout(r, 0));
  if (ctx.signal?.aborted)
    throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");

  const pf = ctx.prefetched; // shorthand for prefetched data

  // ---- Load data (use prefetched when available, fallback to DB) ----
  const chat = pf?.chat ?? chatsSvc.getChat(ctx.userId, ctx.chatId);
  if (!chat) throw new Error("Chat not found");

  const allMessages =
    pf?.messages ?? chatsSvc.getMessages(ctx.userId, ctx.chatId);
  // Filter out the excluded message (e.g. regenerate/swipe target with a blank swipe)
  // so it doesn't appear in macros, WI scanning, or any assembly path.
  const messages = ctx.excludeMessageId
    ? allMessages.filter((m) => m.id !== ctx.excludeMessageId)
    : allMessages;
  // For group chats, resolve the target character; fall back to the chat's primary character
  const characterId = ctx.targetCharacterId || chat.character_id;
  const character =
    pf?.character ?? charactersSvc.getCharacter(ctx.userId, characterId);
  if (!character) throw new Error("Character not found");

  let persona =
    pf?.persona !== undefined
      ? pf.persona
      : personasSvc.resolvePersonaOrDefault(ctx.userId, ctx.personaId);

  // Resolve attached global add-ons for non-prefetched path
  if (persona && !pf) {
    const attachedRefs =
      (persona.metadata?.attached_global_addons as Array<{
        id: string;
        enabled: boolean;
      }>) ?? [];
    const enabledIds = attachedRefs.filter((a) => a.enabled).map((a) => a.id);
    if (enabledIds.length > 0) {
      const resolved = globalAddonsSvc.getGlobalAddonsByIds(
        ctx.userId,
        enabledIds,
      );
      persona = {
        ...persona,
        metadata: { ...persona.metadata, _resolvedGlobalAddons: resolved },
      };
    }
  }

  // Resolve connection
  const connection =
    pf?.connection !== undefined
      ? pf.connection
      : ctx.connectionId
        ? connectionsSvc.getConnection(ctx.userId, ctx.connectionId)
        : connectionsSvc.getDefaultConnection(ctx.userId);

  // Resolve preset: request presetId takes priority, then connection's
  // preset_id, then any more-specific preset-profile binding can override that
  // preset selection for the active chat/character context.
  const requestedPresetId = ctx.presetId || connection?.preset_id || null;
  const resolvedProfile =
    ctx.forcePresetId && ctx.presetId
      ? { preset_id: ctx.presetId, binding: null, source: "none" as const }
      : presetProfilesSvc.resolveProfile(
          ctx.userId,
          requestedPresetId,
          chat.id,
          characterId,
          { isGroup: chat.metadata?.group === true },
        );
  const resolvedPresetId = resolvedProfile.preset_id;

  let preset: Preset | null = null;
  const prefetchedPreset = pf?.preset !== undefined ? pf.preset : null;
  if (resolvedPresetId) {
    preset =
      prefetchedPreset?.id === resolvedPresetId
        ? prefetchedPreset
        : presetsSvc.getPreset(ctx.userId, resolvedPresetId);
  } else {
    preset = prefetchedPreset;
  }

  // Extract Loom structures from preset
  const blocks: PromptBlock[] = (preset?.prompt_order ?? []).map(
    (b: PromptBlock) => ({ ...b }),
  );
  const prompts = preset?.prompts ?? {};
  const promptBehavior: PromptBehavior = prompts.promptBehavior ?? {};
  const completionSettings: CompletionSettings =
    prompts.completionSettings ?? {};
  const samplerOverrides: SamplerOverrides | null =
    preset?.parameters?.samplerOverrides ?? null;

  // Apply preset profile binding after the effective preset has been resolved.
  if (resolvedProfile.binding && blocks.length) {
    presetProfilesSvc.applyProfileToBlocks(blocks, resolvedProfile.binding);
  }
  presetProfilesSvc.normalizeCategoryBlockStates(blocks);

  // Reorder blocks so the position field (pre_history / post_history /
  // in_history) is honoured relative to the chat_history marker.
  reorderBlocksByPosition(blocks);

  // If no blocks, fall back to legacy mapping
  if (!blocks.length) {
    return await legacyAssembly(
      messages,
      ctx.generationType,
      character,
      persona,
      chat,
      connection,
      ctx.userId,
      ctx.signal,
    );
  }

  // ---- Pre-flight: kick off cortex query ----
  // The cortex query runs concurrently with world info activation and macro
  // setup below. Prompt assembly only ever consumes warm-cache hits from this
  // request path; on a cold miss we fall back immediately so cortex never
  // blocks generation or dry-run rendering.
  const cortexConfig =
    pf?.cortexConfig ?? memoryCortex.getCortexConfig(ctx.userId);
  let cortexChatMemSettings:
    | import("./embeddings.service").ChatMemorySettings
    | null = null;
  let cortexPerChatOverrides:
    | import("./embeddings.service").PerChatMemoryOverrides
    | null = null;

  if (cortexConfig.enabled) {
    const cmRaw =
      pf?.allSettings.get("chatMemorySettings") ??
      settingsSvc.getSetting(ctx.userId, "chatMemorySettings")?.value ??
      null;
    cortexChatMemSettings = cmRaw
      ? embeddingsSvc.normalizeChatMemorySettings(cmRaw)
      : null;
    cortexPerChatOverrides =
      (chat.metadata?.memory_settings as
        | import("./embeddings.service").PerChatMemoryOverrides
        | undefined) ?? null;

    // Fire cortex retrieval as best-effort warm-cache work for subsequent
    // generations. This must stay detached from the hot path.
    // Build query text eagerly so it's available for both main + linked queries.
    const embCfgPromise = pf?.embeddingConfig
      ? Promise.resolve(pf.embeddingConfig)
      : embeddingsSvc.getEmbeddingConfig(ctx.userId);

    // Combine the generation's own abort with the chat-scoped background
    // signal. Either firing tears down the fire-and-forget task: stop on
    // the current gen OR a newer gen arriving on this chat aborts any
    // orphan cortex/databank work left over from prior gens.
    const chatBgSignal = getChatBackgroundSignal(ctx.userId, ctx.chatId);
    const cortexSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, chatBgSignal])
      : chatBgSignal;

    void (async () => {
      const embCfg = await embCfgPromise;
      if (cortexSignal.aborted) return;
      const effective = cortexChatMemSettings
        ? embeddingsSvc.resolveEffectiveChatMemorySettings(
            cortexChatMemSettings,
            embCfg,
          )
        : embeddingsSvc.DEFAULT_CHAT_MEMORY_SETTINGS;

      const cortexQueryText = buildQueryText(
        messages,
        effective,
        getReasoningStripOptions(ctx.userId),
      );
      const recentContent = messages
        .slice(-6)
        .map((m) => m.content)
        .join(" ");
      const emotionalContext = buildEmotionalContext(recentContent);

      // Fire main cortex query + linked cortex queries in parallel. The
      // combined signal is threaded through so a user-initiated stop OR a
      // newer generation on this chat tears down the embedding API call
      // and LanceDB retrieval instead of letting the background task live
      // on as an orphan.
      const mainQuery = memoryCortex.queryCortex(
        {
          chatId: ctx.chatId,
          userId: ctx.userId,
          queryText: cortexQueryText,
          emotionalContext,
          generationType: ctx.generationType,
          topK:
            cortexPerChatOverrides?.retrievalTopK ?? effective.retrievalTopK,
          includeConsolidations: cortexConfig.consolidation.enabled,
          includeRelationships: cortexConfig.retrieval.relationshipInjection,
          excludeMessageIds: ctx.excludeMessageId
            ? [ctx.excludeMessageId]
            : undefined,
        },
        cortexConfig,
        cortexSignal,
      );

      // Linked cortex queries use the same queryText for semantic relevance
      const linkedQuery = memoryCortex.queryLinkedCortex(
        ctx.chatId,
        ctx.userId,
        cortexConfig,
        cortexQueryText,
        cortexSignal,
      );

      await Promise.all([mainQuery, linkedQuery]);
    })().catch((err) => {
      if (cortexSignal.aborted) return;
      console.warn("[prompt-assembly] Background cortex query failed:", err);
    });
  }

  // ---- Pre-flight: kick off databank retrieval ----
  // When chat.metadata.memory_isolation is set, the chat opts out of every
  // character-scoped memory source so a "fresh" chat can share a character
  // without inheriting prior conversation knowledge. We still honour chat-scoped
  // and global databanks, world books remain untouched (they read as lore, not
  // memory), and the character's own prompt fields (description, personality,
  // scenario, etc.) are always used — isolation only hides long-term recall.
  const memoryIsolated = chat.metadata?.memory_isolation === true;
  const databankCharIds =
    memoryIsolated || !character?.id ? [] : [character.id];
  const databankCrossRefs = {
    characterDatabankIds: memoryIsolated
      ? []
      : getCharacterDatabankIds(character?.extensions),
    chatDatabankIds:
      (chat.metadata?.chat_databank_ids as string[] | undefined) ?? [],
  };
  const activeDatabankIds = databankSvc.resolveActiveDatabankIds(
    ctx.userId,
    ctx.chatId,
    databankCharIds,
    databankCrossRefs,
  );
  const databankQueryPreview = messages
    .slice(-6)
    .map((m) => m.content)
    .join(" ");
  let databankEmbeddingConfigPromise: Promise<
    Awaited<ReturnType<typeof embeddingsSvc.getEmbeddingConfig>>
  > | null = null;
  const getDatabankEmbeddingConfig = () => {
    if (pf?.embeddingConfig) {
      return Promise.resolve(pf.embeddingConfig);
    }
    if (!databankEmbeddingConfigPromise) {
      databankEmbeddingConfigPromise = embeddingsSvc.getEmbeddingConfig(
        ctx.userId,
      );
    }
    return databankEmbeddingConfigPromise;
  };
  let databankPrefetchPromise: Promise<
    import("./databank").DatabankRetrievalResult
  > | null = null;
  {
    if (activeDatabankIds.length > 0) {
      const chatBgSignal = getChatBackgroundSignal(ctx.userId, ctx.chatId);
      const dbSignal = ctx.signal
        ? AbortSignal.any([ctx.signal, chatBgSignal])
        : chatBgSignal;

      databankPrefetchPromise = (async () => {
        const embCfg = await getDatabankEmbeddingConfig();
        if (!embCfg.enabled) return { chunks: [], formatted: "", count: 0 };
        if (dbSignal.aborted) return { chunks: [], formatted: "", count: 0 };
        const retrievalTopK = databankSvc.loadDatabankSettings(
          ctx.userId,
        ).retrievalTopK;
        return await databankSvc.searchDatabanks(
          ctx.userId,
          ctx.chatId,
          activeDatabankIds,
          databankQueryPreview,
          retrievalTopK,
          dbSignal,
        );
      })();

      void databankPrefetchPromise.catch((err) => {
        if (dbSignal.aborted) return;
        console.warn(
          "[prompt-assembly] Background databank query failed:",
          err,
        );
      });
    }
  }

  // ---- World Info activation ----
  const globalWorldBooks =
    pf?.allSettings.get("globalWorldBooks") ??
    (settingsSvc.getSetting(ctx.userId, "globalWorldBooks")?.value as
      | string[]
      | undefined) ??
    [];
  const chatWorldBookIds =
    (chat.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
  const wiSources =
    pf?.worldInfoSources ??
    collectWorldInfoSources(
      ctx.userId,
      character,
      persona,
      globalWorldBooks,
      chatWorldBookIds,
    );
  const wiEntries = wiSources.entries;
  const wiState: WiState = (chat.metadata?.wi_state as WiState) ?? {};
  const worldInfoSettings =
    pf?.allSettings.get("worldInfoSettings") ??
    (settingsSvc.getSetting(ctx.userId, "worldInfoSettings")?.value as
      | Partial<WorldInfoSettings>
      | undefined) ??
    {};
  const wiResult = activateWorldInfo({
    entries: wiEntries,
    messages,
    chatTurn: messages.length,
    wiState,
    settings: worldInfoSettings,
  });

  // Yield after world-info activation — the keyword scanning loop above is
  // synchronous and can block for 50-200ms on large setups (hundreds of
  // entries × thousands of messages). Yielding here lets Bun drain its I/O
  // queue before the next heavy phase (vector retrieval, macro evaluation).
  if (wiEntries.length > 50) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  // Optional vector retrieval for vectorized world book entries.
  // These entries are merged with keyword-activated entries when enabled.
  // When pre-computed results are available (from the generation pipeline's
  // council enrichment phase), reuse them to avoid redundant embedding queries.
  const vectorQueryPreview = await getWorldInfoVectorQueryPreview(
    ctx.userId,
    messages,
  );
  let vectorActivated = ctx.precomputedVectorEntries ?? null;
  let vectorRetrievalDetails: VectorWorldInfoRetrievalResult | null = null;
  if (!vectorActivated) {
    try {
      const detailed = await collectVectorActivatedWorldInfoDetailed(
        ctx.userId,
        ctx.chatId,
        wiSources.worldBookIds,
        wiEntries,
        messages,
        ctx.signal,
      );
      vectorActivated = detailed.entries;
      vectorRetrievalDetails = detailed;

      if (detailed.blockerMessages.length > 0) {
        // Only log actionable blockers. Suppress benign states where the user
        // simply hasn't opted into vector search (embeddings disabled, no
        // vector-enabled entries, etc.). Log when vectorized entries exist but
        // can't be searched, or when config is incomplete (no API key, etc.).
        const benignBlockers = new Set([
          "Embeddings are disabled, so lorebooks will use keyword matching only.",
          "World-book vectorization is disabled in embeddings settings.",
          "This chat has no vector-enabled, non-disabled, non-empty lorebook entries to search.",
        ]);
        const hasActionableBlocker = detailed.blockerMessages.some(
          (m) => !benignBlockers.has(m),
        );
        if (hasActionableBlocker || detailed.eligibleCount > 0) {
          console.debug(
            "[prompt-assembly] Vector WI blocked: %s (eligible=%d, books=%d)",
            detailed.blockerMessages.join("; "),
            detailed.eligibleCount,
            wiSources.worldBookIds.length,
          );
        }
      } else {
        console.debug(
          "[prompt-assembly] Vector WI retrieval: eligible=%d, hits=%d, afterThreshold=%d, afterRerank=%d, shortlisted=%d (topK=%d)",
          detailed.eligibleCount,
          detailed.hitsBeforeThreshold,
          detailed.hitsAfterThreshold,
          detailed.hitsAfterRerankCutoff,
          detailed.entries.length,
          detailed.topK,
        );
      }
    } catch (err) {
      // Propagate aborts so the entire assembly unwinds instead of silently
      // continuing with keyword-only results after the user stopped generation.
      if (ctx.signal?.aborted || (err as any)?.name === "AbortError") throw err;
      console.warn(
        "[prompt-assembly] Vector world info activation failed, continuing with keyword-only:",
        err,
      );
      vectorActivated = [];
    }
  }
  const mergedWorldInfo = mergeActivatedWorldInfoEntries(
    wiResult.activatedEntries,
    vectorActivated,
    worldInfoSettings,
    wiSources.bookSourceMap,
  );
  const wiCache = mergedWorldInfo.cache;
  wiResult.activatedEntries = mergedWorldInfo.activatedEntries;
  const activatedWorldInfo = mergedWorldInfo.activatedWorldInfo;

  const worldInfoStats = {
    ...wiResult.stats,
    activatedBeforeBudget: mergedWorldInfo.activatedBeforeBudget,
    activatedAfterBudget: mergedWorldInfo.activatedAfterBudget,
    evictedByBudget: mergedWorldInfo.evictedByBudget,
    estimatedTokens: mergedWorldInfo.estimatedTokens,
    keywordActivated: mergedWorldInfo.keywordActivated,
    vectorActivated: mergedWorldInfo.vectorActivated,
    totalActivated: mergedWorldInfo.totalActivated,
    deduplicated: mergedWorldInfo.deduplicated,
    queryPreview: vectorQueryPreview,
    vectorRetrieval: vectorRetrievalDetails
      ? {
          eligibleCount: vectorRetrievalDetails.eligibleCount,
          hitsBeforeThreshold: vectorRetrievalDetails.hitsBeforeThreshold,
          hitsAfterThreshold: vectorRetrievalDetails.hitsAfterThreshold,
          thresholdRejected: vectorRetrievalDetails.thresholdRejected,
          hitsAfterRerankCutoff: vectorRetrievalDetails.hitsAfterRerankCutoff,
          rerankRejected: vectorRetrievalDetails.rerankRejected,
          topK: vectorRetrievalDetails.topK,
          blockerMessages: vectorRetrievalDetails.blockerMessages,
        }
      : undefined,
  };

  // ---- Defer WI state persistence to after generation ----
  // Only carry the keys this writer owns. The post-generation save uses
  // mergeChatMetadata so any user-driven changes (alt field selections, world
  // book attachments, author's notes) that landed during generation survive.
  const deferredWiState = {
    chatId: chat.id,
    partial: { wi_state: wiResult.wiState } as Record<string, any>,
  };

  // ---- Macro engine ----
  initMacros();
  const groupCharsMap = pf?.groupCharacters;
  const resolveCharName = (cid: string) => {
    const char =
      groupCharsMap?.get(cid) ?? charactersSvc.getCharacter(ctx.userId, cid);
    return char ? getEffectiveCharacterName(char) : undefined;
  };
  const groupCharacterNames = resolveGroupCharacterNames(chat, resolveCharName);
  const mutedIds = chatsSvc.getGroupMutedIds(chat);
  const groupNotMutedNames =
    groupCharacterNames && mutedIds.length > 0
      ? resolveGroupCharacterNames(chat, (cid) =>
          mutedIds.includes(cid) ? undefined : resolveCharName(cid),
        )
      : undefined;
  // Resolve alternate field overrides from per-chat bindings, then group scenario override
  const effectiveCharacter = resolveGroupScenarioOverride(
    resolveCharacterWithAlternateFields(character, chat),
    chat,
    ctx.userId,
  );

  const macroEnv: MacroEnv = buildEnv({
    character: effectiveCharacter,
    persona,
    chat,
    messages,
    generationType: ctx.generationType,
    connection,
    groupCharacterNames,
    groupNotMutedNames,
    targetCharacterId: ctx.targetCharacterId,
    targetCharacterName: ctx.targetCharacterId
      ? getEffectiveCharacterName(effectiveCharacter)
      : undefined,
    signal: ctx.signal,
  });

  // Prompt variables — resolve creator-defined schemas + end-user overrides and
  // surface them on env.extra so {{var::name}} / {{hasVar::name}} / {{varDefault::name}}
  // can read consistent values across every block in this assembly.
  resolvePromptVariables(macroEnv, blocks, preset);

  // Use prefetched settings or batch-load all needed settings in a single query
  const settingsMap =
    pf?.allSettings ??
    settingsSvc.getSettingsByKeys(ctx.userId, [
      "reasoningSettings",
      "selectedDefinition",
      "selectedBehaviors",
      "selectedPersonalities",
      "chimeraMode",
      "lumiaQuirks",
      "lumiaQuirksEnabled",
      "oocEnabled",
      "lumiaOOCInterval",
      "lumiaOOCStyle",
      "sovereignHand",
      "selectedLoomStyles",
      "selectedLoomUtils",
      "selectedLoomRetrofits",
      "guidedGenerations",
      "promptBias",
      "theme",
      "contextFilters",
      "summarization",
      "chatMemorySettings",
      "databankSettings",
      "council_settings",
    ]);

  // Populate reasoning macros from user settings
  const reasoningVal = settingsMap.get("reasoningSettings");
  if (reasoningVal) {
    macroEnv.extra.reasoningPrefix = reasoningVal.prefix ?? "";
    macroEnv.extra.reasoningSuffix = reasoningVal.suffix ?? "";
  }

  // Populate theme info for {{userColorMode}} macro
  const themeVal = settingsMap.get("theme");
  if (themeVal) {
    macroEnv.extra.theme = { mode: themeVal.mode ?? "dark" };
  }

  // Populate Lumia / Loom / Council / OOC / Sovereign Hand context for macros
  populateLumiaLoomContext(macroEnv, ctx.userId, chat, ctx, settingsMap);

  // ---- Impersonate one-liner mode: skip preset blocks, just chat history + impersonation prompt ----
  if (
    ctx.generationType === "impersonate" &&
    ctx.impersonateMode === "oneliner"
  ) {
    return await onelinerImpersonation(
      messages,
      character,
      persona,
      chat,
      connection,
      preset,
      promptBehavior,
      completionSettings,
      samplerOverrides,
      ctx,
      macroEnv,
      reasoningVal,
    );
  }

  // ---- Pre-loop: retrieve chat vector memories ----
  // Reuse settings resolved during cortex pre-flight (avoids duplicate DB reads).
  // Fall back to batch-loaded settings for the non-cortex path.
  const chatMemSettingsRaw = settingsMap.get("chatMemorySettings") ?? null;
  const chatMemSettings =
    cortexChatMemSettings ??
    (chatMemSettingsRaw
      ? embeddingsSvc.normalizeChatMemorySettings(chatMemSettingsRaw)
      : null);
  const databankSettings = databankSvc.normalizeDatabankSettings(
    settingsMap.get("databankSettings"),
  );
  const perChatOverrides =
    cortexPerChatOverrides ??
    (chat.metadata?.memory_settings as
      | import("./embeddings.service").PerChatMemoryOverrides
      | undefined) ??
    null;

  // Memory Cortex: use warm cache hits only. On a cold miss, fall back
  // immediately to vector retrieval so background cortex work never stalls the
  // generation path.
  let cortexResult: memoryCortex.CortexResult | null = null;

  let memoryResult: Awaited<ReturnType<typeof collectChatVectorMemory>>;

  if (cortexConfig.enabled) {
    // Fast path: warm cache from a previous generation (synchronous, no I/O)
    cortexResult = memoryCortex.getCachedCortexResult(ctx.chatId);

    if (cortexResult && cortexResult.memories.length > 0) {
      memoryResult = formatCortexForAssembly(
        cortexResult,
        cortexConfig,
        character,
        macroEnv,
        ctx.chatId,
      );
    } else {
      // Genuinely no memories (new chat, no chunks, etc.) — fall back to vector retrieval
      memoryResult = await safeCollectChatVectorMemory(
        ctx.userId,
        ctx.chatId,
        messages,
        chatMemSettings,
        perChatOverrides,
        ctx.excludeMessageId,
      );
    }
  } else {
    // Existing path: pure vector retrieval
    memoryResult = await safeCollectChatVectorMemory(
      ctx.userId,
      ctx.chatId,
      messages,
      chatMemSettings,
      perChatOverrides,
      ctx.excludeMessageId,
    );
  }

  // Merge linked cortex data (vaults + interlinks) if available
  const linkedCortexResult = memoryCortex.getCachedLinkedCortexResult(
    ctx.chatId,
  );
  let linkedMemoryText = "";
  if (
    linkedCortexResult &&
    (linkedCortexResult.vaults.length > 0 ||
      linkedCortexResult.interlinks.length > 0)
  ) {
    const linkedBudget = Math.floor(cortexConfig.contextTokenBudget * 0.3);
    const linkedFormatted = memoryCortex.formatLinkedCortexSection(
      linkedCortexResult.vaults,
      linkedCortexResult.interlinks,
      {
        mode: cortexConfig.formatterMode,
        tokenBudget: linkedBudget,
        currentSpeakerName: character?.name,
      },
    );
    linkedMemoryText = linkedFormatted.text;
  }

  // Store in macroEnv for {{memories}} macro access
  const combinedFormatted = linkedMemoryText
    ? memoryResult.formatted
      ? memoryResult.formatted + "\n\n" + linkedMemoryText
      : linkedMemoryText
    : memoryResult.formatted;

  macroEnv.extra.memory = {
    chunks: memoryResult.chunks,
    formatted: combinedFormatted,
    count: memoryResult.count,
    enabled: memoryResult.enabled,
    settings: chatMemSettings ?? embeddingsSvc.DEFAULT_CHAT_MEMORY_SETTINGS,
  };

  // ---- Databank retrieval ----
  // Use the warm-cache pattern: check if a previous generation cached results.
  // On a cold miss, await the pre-flight query so the current generation still
  // gets databank context instead of only warming the cache for the next send.
  const databankEmbCfg = await getDatabankEmbeddingConfig();
  let databankResult = databankSvc.getCachedDatabankResult(
    ctx.userId,
    ctx.chatId,
    databankSettings.retrievalTopK,
  );
  let databankRetrievalState: DatabankStats["retrievalState"] =
    "skipped_no_active_banks";
  if (activeDatabankIds.length === 0) {
    databankResult = { chunks: [], formatted: "", count: 0 };
  } else if (!databankEmbCfg.enabled) {
    databankRetrievalState = "skipped_embeddings_disabled";
    databankResult = { chunks: [], formatted: "", count: 0 };
  } else if (databankResult) {
    databankRetrievalState = "cache_hit";
  } else if (databankPrefetchPromise) {
    databankResult = await databankPrefetchPromise;
    databankRetrievalState = "awaited_prefetch";
  } else {
    databankResult = await databankSvc.searchDatabanks(
      ctx.userId,
      ctx.chatId,
      activeDatabankIds,
      databankQueryPreview,
      databankSettings.retrievalTopK,
      ctx.signal,
    );
    databankRetrievalState = "awaited_direct";
  }

  macroEnv.extra.databank = {
    chunks: databankResult?.chunks ?? [],
    formatted: databankResult?.formatted ?? "",
    count: databankResult?.count ?? 0,
    enabled: activeDatabankIds.length > 0,
  };

  // Detect if any enabled block uses the {{memories}} macro
  const macroHandlesMemory = blocks.some(
    (b) => b.enabled && b.content && /\{\{memories(\b|::|\}\})/.test(b.content),
  );

  // Detect if any enabled block uses the {{databank}} macro
  const macroHandlesDatabank = blocks.some(
    (b) => b.enabled && b.content && /\{\{databank(\b|::|\}\})/.test(b.content),
  );

  // ---- Resolve #mentions in user messages ----
  // 1. Strip #tags from ALL user messages so raw tags never reach the LLM.
  // 2. Resolve + build the document appendix only from the LAST user message's tags.
  // This handles queued messages, regen, swipe, and dry-run correctly.
  let databankMentionAppendix = "";
  {
    // Isolated chats don't resolve character-scoped document mentions either —
    // the user can still reference chat-scoped or global docs by slug.
    const charIds = databankCharIds;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].is_user) {
        lastUserIdx = i;
        break;
      }
    }
    let mentionYieldCounter = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.is_user || !msg.content.includes("#")) continue;
      if ((mentionYieldCounter++ & 15) === 0) {
        await yieldAndCheckAbort(ctx.signal);
      } else if (ctx.signal?.aborted) {
        throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      try {
        const isLast = i === lastUserIdx;
        const mentionResult = await databankSvc.resolveMentions(
          ctx.userId,
          msg.content,
          ctx.chatId,
          charIds,
          isLast
            ? messages
                .slice(-6)
                .map((m) => m.content)
                .join(" ")
            : undefined,
        );
        // Always strip tags from the in-memory content
        if (mentionResult.cleanedContent !== msg.content) {
          msg.content = mentionResult.cleanedContent;
        }
        // Only build appendix from the last user message
        if (isLast && mentionResult.resolvedDocuments.length > 0) {
          databankMentionAppendix = databankSvc.formatMentionsAsAppendix(
            mentionResult.resolvedDocuments,
          );
        }
      } catch (err) {
        console.warn(
          "[prompt-assembly] Databank mention resolution failed:",
          err,
        );
      }
    }
  }

  await resolveWorldInfoOutlets(
    mergedWorldInfo.activatedEntries,
    macroEnv,
    ctx.signal,
  );

  // ---- Resolve macros in world info entries ----
  // WI entry content may contain macros (e.g. {{user}}, {{char}}, {{time}}).
  // Resolve them before injection so all positions get macro-evaluated content.
  // Flattened into a single loop across all buckets with cooperative yields
  // every 8 entries so /generate/stop can land during large lorebooks.
  {
    const allWiEntries: Array<{ content: string }>[] = [
      wiCache.before,
      wiCache.after,
      wiCache.anBefore,
      wiCache.anAfter,
      wiCache.emBefore,
      wiCache.emAfter,
      wiCache.depth,
    ];
    let wiEvalCounter = 0;
    for (const bucket of allWiEntries) {
      for (const entry of bucket) {
        if ((wiEvalCounter++ & 7) === 0) {
          await yieldAndCheckAbort(ctx.signal);
        } else if (ctx.signal?.aborted) {
          throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        entry.content = (
          await evaluate(entry.content, macroEnv, registry)
        ).text;
      }
    }
  }
  pruneEmptyWorldInfoCacheEntries(wiCache);

  // Yield before the main block iteration — WI macro evaluation above can run
  // 100s of macro expansions back-to-back with only microtask yields between
  // them. A macrotask yield here gives /generate/stop a window to land.
  await yieldAndCheckAbort(ctx.signal);

  // ---- Assembly loop ----
  const result: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];
  const pendingAppends: PendingAppend[] = [];
  const pendingDepthBlocks: {
    role: LlmMessage["role"];
    depth: number;
    content: string;
    blockName: string;
    blockId: string;
    marker?: string;
  }[] = [];
  let chatHistoryInserted = false;
  let chatHistoryCount = 0;
  let hasWiBefore = false;
  let hasWiAfter = false;
  let firstChatIdx = -1;
  let jailbreakBlockResolved = false;
  let blockYieldCounter = 0;

  for (const block of blocks) {
    // Skip disabled blocks
    if (!block.enabled) continue;

    // Cooperative cancellation: yield every 4 enabled blocks so a pending
    // /generate/stop can interrupt the chain of macro evaluations below.
    // Microtask awaits in each handler don't drain Bun's HTTP queue on
    // constrained runtimes — we need a real macrotask tick.
    if ((blockYieldCounter++ & 3) === 0) {
      await yieldAndCheckAbort(ctx.signal);
    } else if (ctx.signal?.aborted) {
      throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    // Skip category markers only if they carry no content
    if (block.marker === "category" && !block.content?.trim()) continue;

    // Injection trigger filtering — if block specifies triggers, skip if current
    // generation type is not in the list
    if (block.injectionTrigger && block.injectionTrigger.length > 0) {
      if (!block.injectionTrigger.includes(ctx.generationType)) continue;
    }

    // ---- Handle by marker type ----

    if (block.marker === "chat_history") {
      // Inject memories as system message ONLY if no macro handles them
      if (!macroHandlesMemory && memoryResult.count > 0) {
        const memoryContent = memoryResult.formatted;
        result.push({ role: "system", content: memoryContent });
        breakdown.push({
          type: "long_term_memory",
          name: "Long-Term Memory",
          role: "system",
          content: memoryContent,
        });
      }

      // Inject databank content as system message ONLY if no macro handles it
      if (!macroHandlesDatabank && macroEnv.extra.databank?.count > 0) {
        const databankContent = macroEnv.extra.databank.formatted;
        result.push({ role: "system", content: databankContent });
        breakdown.push({
          type: "databank",
          name: "Databank",
          role: "system",
          content: databankContent,
        });
      }

      // Insert new-chat separator if configured
      const newChatPrompt = promptBehavior.newChatPrompt;
      if (newChatPrompt) {
        const resolved = (await evaluate(newChatPrompt, macroEnv, registry))
          .text;
        const trimmed = resolved.trim();
        if (trimmed && !isDecorativeNewChatSeparator(trimmed)) {
          result.push({ role: "system", content: trimmed });
          breakdown.push({
            type: "separator",
            name: "New Chat Prompt",
            role: "system",
            content: trimmed,
          });
        }
      }

      firstChatIdx = result.length;

      // Apply message limit — keep only the N most recent messages when enabled.
      // This works independently of summarization; users can use {{loomSummary}}
      // in their preset to retain context from older messages.
      const summarizationSettings = settingsMap.get("summarization") as
        | { messageLimitEnabled?: boolean; messageLimitCount?: number }
        | undefined;
      let effectiveMessages = messages;
      if (
        summarizationSettings?.messageLimitEnabled &&
        summarizationSettings.messageLimitCount != null &&
        summarizationSettings.messageLimitCount > 0
      ) {
        effectiveMessages = messages.slice(
          -summarizationSettings.messageLimitCount,
        );
      }

      // Insert chat messages — evaluate macros in each message's content
      // Skip messages marked as hidden drafts (extra.hidden === true)
      // (excludeMessageId is already filtered out at the top of assemblePrompt)
      // Pre-resolve all attachment files in parallel so the per-message loop
      // doesn't pay sequential file I/O costs per attachment.
      const attachmentImageIds = new Set<string>();
      for (const msg of effectiveMessages) {
        if (msg.extra?.hidden === true) continue;
        const atts = Array.isArray(msg.extra?.attachments)
          ? msg.extra.attachments
          : [];
        for (const att of atts) {
          if (att.image_id) attachmentImageIds.add(att.image_id);
        }
      }
      const attachmentCache = new Map<string, string | null>();
      if (attachmentImageIds.size > 0) {
        const entries = await Promise.all(
          [...attachmentImageIds].map(
            async (id) =>
              [id, await resolveAttachmentBase64(ctx.userId, id)] as const,
          ),
        );
        for (const [id, b64] of entries) attachmentCache.set(id, b64);
      }

      let historyCount = 0;
      const historyParts: string[] = [];
      let chatHistoryYieldCounter = 0;
      for (const msg of effectiveMessages) {
        if (msg.extra?.hidden === true) continue;
        // Cooperative yield every 16 messages. The previous fix yielded once
        // per block (≈30 times across the whole assembly), but long chats do
        // all their macro work inside THIS single block and only yielded once
        // before entering the loop. On a 200-message chat that's 200 sequential
        // awaits on microtasks — Bun's HTTP queue never drains and the stop
        // button is dead until the loop completes.
        if ((chatHistoryYieldCounter++ & 15) === 0) {
          await yieldAndCheckAbort(ctx.signal);
        } else if (ctx.signal?.aborted) {
          throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        const role: "user" | "assistant" = msg.is_user ? "user" : "assistant";
        // Inline fast-path: most stored messages contain no macro markers.
        // Skip the full evaluate() call (lex → parse → AST walk → diagnostics
        // alloc) when no markers are present. This mirrors the evaluator's own
        // fast-path but avoids the function-call overhead and 4 string scans
        // that evaluate() performs before reaching its early return.
        const rawContent = msg.content;
        const needsEval =
          rawContent.includes("{{") ||
          rawContent.includes("<USER>") ||
          rawContent.includes("<BOT>") ||
          rawContent.includes("<CHAR>");
        const resolvedContent = needsEval
          ? healFormattingArtifacts(
              (await evaluate(rawContent, macroEnv, registry)).text,
            )
          : rawContent;
        historyParts.push(resolvedContent);
        const attachments = Array.isArray(msg.extra?.attachments)
          ? msg.extra.attachments
          : [];
        if (attachments.length > 0) {
          // Build multipart content: text + attachment parts. Skip the text part
          // when it's blank so strict providers (Anthropic et al) don't reject
          // the request for empty content blocks.
          const parts: import("../llm/types").LlmMessagePart[] = [];
          if (resolvedContent.trim().length > 0) {
            parts.push({ type: "text", text: resolvedContent });
          }
          for (const att of attachments) {
            const b64 = attachmentCache.get(att.image_id) ?? null;
            if (!b64) continue;
            if (att.type === "image") {
              parts.push({
                type: "image",
                data: b64,
                mime_type: att.mime_type,
              });
            } else if (att.type === "audio") {
              parts.push({
                type: "audio",
                data: b64,
                mime_type: att.mime_type,
              });
            }
          }
          if (parts.length > 0) {
            result.push(markAsChatHistory({ role, content: parts }));
          } else {
            result.push(markAsChatHistory({ role, content: resolvedContent }));
          }
        } else {
          result.push(markAsChatHistory({ role, content: resolvedContent }));
        }
        historyCount++;
      }
      breakdown.push({
        type: "chat_history",
        name: "Chat History",
        messageCount: historyCount,
        firstMessageIndex: firstChatIdx,
        content: historyParts.join("\n"),
      });

      // Append databank #mention context to the last user message
      if (databankMentionAppendix) {
        for (let i = result.length - 1; i >= firstChatIdx; i--) {
          if (result[i].role === "user") {
            if (typeof result[i].content === "string") {
              result[i] = {
                ...result[i],
                content: result[i].content + databankMentionAppendix,
              };
            } else {
              const parts = [
                ...(result[i]
                  .content as import("../llm/types").LlmMessagePart[]),
              ];
              const textIdx = parts.findIndex((p) => p.type === "text");
              if (textIdx >= 0) {
                const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
                parts[textIdx] = {
                  type: "text",
                  text: tp.text + databankMentionAppendix,
                };
              } else {
                parts.unshift({ type: "text", text: databankMentionAppendix });
              }
              result[i] = { ...result[i], content: parts };
            }
            breakdown.push({
              type: "databank_mention",
              name: "Databank Reference",
              role: "user",
              content: databankMentionAppendix,
            });
            break;
          }
        }
      }

      // Merge consecutive user messages (queued messages) into single LLM turns
      historyCount = mergeConsecutiveUserMessages(
        result,
        firstChatIdx,
        historyCount,
      );

      chatHistoryInserted = true;
      chatHistoryCount = historyCount;

      // Strip reasoning from older chat history messages based on keepInHistory
      if (reasoningVal) {
        stripReasoningFromChatHistory(
          result,
          firstChatIdx,
          historyCount,
          reasoningVal,
        );
      }

      // Apply context filters (details blocks, loom tags, HTML tags)
      const contextFiltersVal = settingsMap.get("contextFilters") as
        | ContextFilters
        | undefined;
      if (contextFiltersVal) {
        applyContextFilters(
          result,
          firstChatIdx,
          historyCount,
          contextFiltersVal,
        );
      }
      continue;
    }

    if (block.marker === "world_info_before") {
      hasWiBefore = true;
      if (wiCache.before.length > 0) {
        for (const entry of wiCache.before) {
          const role = (block.role as LlmMessage["role"]) || entry.role;
          result.push({ role, content: entry.content });
          breakdown.push({
            type: "world_info",
            name: formatWorldInfoBreakdownName(
              "World Info Before",
              entry.entryLabel,
            ),
            role,
            content: entry.content,
          });
        }
      }
      continue;
    }

    if (block.marker === "world_info_after") {
      hasWiAfter = true;
      if (wiCache.after.length > 0) {
        for (const entry of wiCache.after) {
          const role = (block.role as LlmMessage["role"]) || entry.role;
          result.push({ role, content: entry.content });
          breakdown.push({
            type: "world_info",
            name: formatWorldInfoBreakdownName(
              "World Info After",
              entry.entryLabel,
            ),
            role,
            content: entry.content,
          });
        }
      }
      continue;
    }

    // Structural markers → resolve via macro
    if (
      block.marker &&
      STRUCTURAL_MARKERS.has(block.marker) &&
      MARKER_TO_MACRO[block.marker]
    ) {
      const macro = MARKER_TO_MACRO[block.marker];
      const resolved = (await evaluate(macro, macroEnv, registry)).text.trim();
      if (resolved) {
        const role = (block.role || "system") as LlmMessage["role"];
        result.push({ role, content: resolved });
        breakdown.push({
          type: "block",
          name: block.name,
          role: block.role,
          content: resolved,
          blockId: block.id,
          marker: block.marker,
        });
      }
      continue;
    }

    // Content-bearing markers and regular blocks → resolve block.content
    const content = block.content || "";
    const rawResolved = (await evaluate(content, macroEnv, registry)).text;

    // Append roles: collect for deferred application after full assembly.
    // Check BEFORE the trim gate so whitespace-only appends (e.g. lone
    // newlines the user deliberately placed between other appends) are kept.
    if (isAppendRole(block.role)) {
      if (rawResolved) {
        pendingAppends.push({
          baseRole: appendBaseRole(block.role),
          depth: block.depth || 0,
          content: rawResolved,
          blockName: block.name,
          blockId: block.id,
        });
      }
      continue;
    }

    const resolved = rawResolved.trim();
    if (resolved) {
      if (block.marker === "jailbreak") jailbreakBlockResolved = true;

      const role: LlmMessage["role"] =
        block.position === "post_history"
          ? block.role === "system" || !block.role
            ? "assistant"
            : (block.role as LlmMessage["role"])
          : (block.role as LlmMessage["role"]) || "system";

      // Blocks with position "in_history" and depth > 0 are deferred for
      // depth-based insertion after WI and Author's Note.
      if (block.position === "in_history" && block.depth > 0) {
        pendingDepthBlocks.push({
          role,
          depth: block.depth,
          content: resolved,
          blockName: block.name,
          blockId: block.id,
          marker: block.marker ?? undefined,
        });
      } else {
        result.push({ role, content: resolved });
        breakdown.push({
          type: "block",
          name: block.name,
          role,
          content: resolved,
          blockId: block.id,
          marker: block.marker ?? undefined,
        });
      }
    }
  }

  // ---- Post-history instructions fallback ----
  // If the character has post_history_instructions but no jailbreak block resolved
  // it (e.g. the preset's jailbreak block is empty or missing the {{jailbreak}} macro),
  // inject the character's post_history_instructions as a system message at the end.
  // This ensures imported cards (especially Risu cards with image command rules in
  // post_history_instructions) work out of the box without manual preset configuration.
  if (!jailbreakBlockResolved && effectiveCharacter.post_history_instructions) {
    const resolved = (
      await evaluate(
        effectiveCharacter.post_history_instructions,
        macroEnv,
        registry,
      )
    ).text.trim();
    if (resolved) {
      result.push({ role: "system", content: resolved });
      breakdown.push({
        type: "block",
        name: "Post-History Instructions (auto)",
        role: "system",
        content: resolved,
        marker: "jailbreak",
      });
    }
  }

  // ---- Long-Term Memory breakdown entry (macro path) ----
  // When memories are injected via {{memories}} macro, their content is embedded
  // inside a block. Add a separate breakdown entry so the prompt breakdown UI
  // shows memories as their own group.
  if (macroHandlesMemory && memoryResult.count > 0 && memoryResult.formatted) {
    breakdown.push({
      type: "long_term_memory",
      name: "Long-Term Memory",
      role: "system",
      content: memoryResult.formatted,
      excludeFromTotal: true, // tokens already counted in the block containing {{memories}}
    });
  }

  // ---- WI auto-injection (if no explicit marker blocks) ----
  //
  // WI position semantics:
  //   0 = "before" → just before chat history
  //   1 = "after"  → just after chat history
  //   2 = AN before, 3 = AN after → around first chat message
  //   4 = depth-based → N messages from the end
  //   5 = EM before, 6 = EM after → around first chat message (example messages area)
  //
  // firstChatIdx = index of the first chat message in `result[]`.
  // We need to compute lastChatIdx = index AFTER the last chat message.

  // Use the count tracked during chat_history insertion (respects message limit + exclusions)
  const lastChatIdx =
    firstChatIdx >= 0 ? firstChatIdx + chatHistoryCount : result.length;

  const dreamWeaverRuntimeBlocks = getDreamWeaverRuntimeBlocks(
    effectiveCharacter,
  ).map((entry) => ({ ...entry, role: "system" as const }));
  if (dreamWeaverRuntimeBlocks.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx : result.length;
    const inserted = injectPromptBlocksAt(
      result,
      breakdown,
      dreamWeaverRuntimeBlocks,
      insertAt,
    );
    if (firstChatIdx >= 0) firstChatIdx += inserted;
  }

  // Position 0: "before" — insert just before chat history
  if (!hasWiBefore && wiCache.before.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx : 0;
    const inserted = injectWorldInfoAt(
      result,
      breakdown,
      wiCache.before,
      insertAt,
      "World Info Before (auto)",
    );
    // Shift all subsequent anchors since we inserted before the chat block
    if (firstChatIdx >= 0) firstChatIdx += inserted;
  }

  // Position 1: "after" — insert just after chat history
  if (!hasWiAfter && wiCache.after.length > 0) {
    const insertAt =
      firstChatIdx >= 0 ? firstChatIdx + chatHistoryCount : result.length;
    injectWorldInfoAt(
      result,
      breakdown,
      wiCache.after,
      Math.min(insertAt, result.length),
      "World Info After (auto)",
    );
  }

  // Positions 2-3 (AN before/after): inject around the start of chat history
  if (wiCache.anBefore.length > 0 && firstChatIdx >= 0) {
    const inserted = injectWorldInfoAt(
      result,
      breakdown,
      wiCache.anBefore,
      firstChatIdx,
      "WI AN Before",
    );
    firstChatIdx += inserted;
  }
  if (wiCache.anAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(
      result,
      breakdown,
      wiCache.anAfter,
      Math.min(insertAt, result.length),
      "WI AN After",
    );
  }

  // Positions 5-6 (EM before/after): inject around the start of chat history
  if (wiCache.emBefore.length > 0 && firstChatIdx >= 0) {
    injectWorldInfoAt(
      result,
      breakdown,
      wiCache.emBefore,
      firstChatIdx,
      "WI EM Before",
    );
  }
  if (wiCache.emAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(
      result,
      breakdown,
      wiCache.emAfter,
      Math.min(insertAt, result.length),
      "WI EM After",
    );
  }

  // Position 4 (depth-based): insert at result.length - depth
  for (const depthEntry of wiCache.depth) {
    const insertAt = Math.max(0, result.length - depthEntry.depth);
    const role = depthEntry.role as LlmMessage["role"];
    result.splice(insertAt, 0, { role, content: depthEntry.content });
    breakdown.push({
      type: "world_info",
      name: formatWorldInfoBreakdownName(
        `WI Depth ${depthEntry.depth}`,
        depthEntry.entryLabel,
      ),
      role: depthEntry.role,
      content: depthEntry.content,
    });
  }

  // ---- Author's Note injection ----
  const authorsNote: AuthorsNote | null = chat.metadata?.authors_note ?? null;
  if (authorsNote && authorsNote.content) {
    const resolvedAN = (await evaluate(authorsNote.content, macroEnv, registry))
      .text;
    if (resolvedAN) {
      const insertAt = Math.max(0, result.length - (authorsNote.depth || 4));
      result.splice(insertAt, 0, {
        role: authorsNote.role || "system",
        content: resolvedAN,
      });
      breakdown.push({
        type: "authors_note",
        name: "Author's Note",
        role: authorsNote.role,
        content: resolvedAN,
      });
    }
  }

  // ---- Depth-based block injection ----
  // Blocks with position "in_history" and depth > 0 are inserted relative to
  // the actual tagged chat-history messages, not the tail of the full prompt.
  // This keeps them inside chat history even when post-history/system utility
  // blocks have already been appended around it.
  for (const depthBlock of pendingDepthBlocks) {
    const insertAt = resolveChatHistoryInsertionIndex(result, depthBlock.depth);
    result.splice(insertAt, 0, {
      role: depthBlock.role,
      content: depthBlock.content,
    });
    breakdown.push({
      type: "block",
      name: depthBlock.blockName,
      role: depthBlock.role,
      content: depthBlock.content,
      blockId: depthBlock.blockId,
      marker: depthBlock.marker,
    });
  }

  // ---- Utility prompt injection ----

  // Guided generations (from batch-loaded settings)
  const guided = normalizeGuidedGenerations(
    settingsMap.get("guidedGenerations"),
  );
  if (guided.length > 0) {
    await applyGuidedGenerations(result, guided, macroEnv, breakdown);
  }

  // Regen feedback injection (user-provided OOC guidance for regeneration)
  if (ctx.regenFeedback) {
    const oocContent = `[OOC: ${ctx.regenFeedback}]`;
    if (ctx.regenFeedbackPosition === "system") {
      // Append as a system message at the end
      result.push({ role: "system", content: oocContent });
      breakdown.push({
        type: "utility",
        name: "Regen Feedback",
        role: "system",
        content: oocContent,
      });
    } else {
      // Append to the last user message
      let injected = false;
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === "user") {
          if (typeof result[i].content === "string") {
            result[i] = {
              ...result[i],
              content: result[i].content + "\n" + oocContent,
            };
          } else {
            const parts = [
              ...(result[i].content as import("../llm/types").LlmMessagePart[]),
            ];
            const textIdx = parts.findIndex((p) => p.type === "text");
            if (textIdx >= 0) {
              const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
              parts[textIdx] = {
                type: "text",
                text: tp.text + "\n" + oocContent,
              };
            } else {
              parts.unshift({ type: "text", text: oocContent });
            }
            result[i] = { ...result[i], content: parts };
          }
          injected = true;
          breakdown.push({
            type: "utility",
            name: "Regen Feedback",
            role: "user",
            content: oocContent,
          });
          break;
        }
      }
      // Fallback: if no user message found, add as a user message
      if (!injected) {
        result.push({ role: "user", content: oocContent });
        breakdown.push({
          type: "utility",
          name: "Regen Feedback",
          role: "user",
          content: oocContent,
        });
      }
    }
  }

  // Continue type: append continueNudge (unless continuePrefill is on)
  if (
    ctx.generationType === "continue" &&
    !completionSettings.continuePrefill
  ) {
    const nudge = promptBehavior.continueNudge;
    if (nudge) {
      const resolved = (await evaluate(nudge, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "system", content: resolved });
        breakdown.push({
          type: "utility",
          name: "Continue Nudge",
          role: "system",
          content: resolved,
        });
      }
    }
  }

  // Continue type: apply continuePostfix to last assistant message
  if (ctx.generationType === "continue" && completionSettings.continuePostfix) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "assistant") {
        if (typeof result[i].content === "string") {
          result[i] = {
            ...result[i],
            content: result[i].content + completionSettings.continuePostfix,
          };
        } else {
          const parts = [
            ...(result[i].content as import("../llm/types").LlmMessagePart[]),
          ];
          const textIdx = parts.findIndex((p) => p.type === "text");
          if (textIdx >= 0) {
            const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
            parts[textIdx] = {
              type: "text",
              text: tp.text + completionSettings.continuePostfix,
            };
          } else {
            parts.push({
              type: "text",
              text: completionSettings.continuePostfix,
            });
          }
          result[i] = { ...result[i], content: parts };
        }
        break;
      }
    }
  }

  // Impersonate type: append impersonation prompt
  if (ctx.generationType === "impersonate") {
    const prompt = promptBehavior.impersonationPrompt;
    const userInput =
      typeof ctx.impersonateInput === "string"
        ? ctx.impersonateInput.trim()
        : "";
    let resolved = "";
    if (prompt) {
      resolved = (await evaluate(prompt, macroEnv, registry)).text;
    }
    if (userInput) {
      resolved = resolved ? `${resolved}\n\n${userInput}` : userInput;
    }
    if (resolved) {
      result.push({ role: "system", content: resolved });
      breakdown.push({
        type: "utility",
        name: "Impersonation Prompt",
        role: "system",
        content: resolved,
      });
    }
  }

  // sendIfEmpty: if last message in result is assistant role and content is blank-ish
  if (promptBehavior.sendIfEmpty && result.length > 0) {
    const last = result[result.length - 1];
    if (
      last.role === "assistant" &&
      typeof last.content === "string" &&
      !last.content.trim()
    ) {
      const resolved = (
        await evaluate(promptBehavior.sendIfEmpty, macroEnv, registry)
      ).text;
      if (resolved) {
        result.push({ role: "user", content: resolved });
        breakdown.push({
          type: "utility",
          name: "Send If Empty",
          role: "user",
          content: resolved,
        });
      }
    }
  }

  // Empty-send nudge: normal generations that start from an assistant-ending
  // chat need a fresh user turn so providers produce a new reply instead of
  // relying on continue semantics. Group/member-targeted nudges use groupNudge.
  const lastVisibleChatMessage = [...messages]
    .reverse()
    .find((msg) => msg.extra?.hidden !== true);
  if (
    ctx.generationType === "normal" &&
    !ctx.targetCharacterId &&
    lastVisibleChatMessage &&
    !lastVisibleChatMessage.is_user &&
    result.length > 0 &&
    result[result.length - 1].role !== "user"
  ) {
    const nudge = promptBehavior.emptySendNudge ?? DEFAULT_EMPTY_SEND_NUDGE;
    if (nudge) {
      const resolved = (await evaluate(nudge, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "user", content: resolved });
        breakdown.push({
          type: "utility",
          name: "Empty Send Nudge",
          role: "user",
          content: resolved,
        });
      }
    }
  }

  // ---- Build group nudge (user message) + assistant prefill ----
  let assistantPrefill: string | undefined;

  // Group chat nudge from preset (e.g. "[Write next reply only as {{char}}]")
  if (ctx.targetCharacterId) {
    const groupNudge = promptBehavior.groupNudge;
    if (groupNudge) {
      const resolved = (await evaluate(groupNudge, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "user", content: resolved });
        breakdown.push({
          type: "utility",
          name: "Group Nudge",
          role: "user",
          content: resolved,
        });
      }
    }
  }

  // Collect assistant prefill: promptBias (Start Reply With) + assistantPrefill/assistantImpersonation
  const prefillParts: string[] = [];

  const promptBiasVal = settingsMap.get("promptBias");
  if (
    promptBiasVal &&
    typeof promptBiasVal === "string" &&
    promptBiasVal.trim()
  ) {
    const resolvedBias = (await evaluate(promptBiasVal, macroEnv, registry))
      .text;
    if (resolvedBias) prefillParts.push(resolvedBias);
  }

  const csPrefill =
    ctx.generationType === "impersonate" &&
    completionSettings.assistantImpersonation
      ? completionSettings.assistantImpersonation
      : completionSettings.assistantPrefill;
  if (csPrefill) {
    const resolvedPrefill = (await evaluate(csPrefill, macroEnv, registry))
      .text;
    if (resolvedPrefill) prefillParts.push(resolvedPrefill);
  }

  if (prefillParts.length > 0) {
    assistantPrefill = prefillParts.join("");
    result.push({ role: "assistant", content: assistantPrefill });
    breakdown.push({
      type: "utility",
      name: "Assistant Prefill",
      role: "assistant",
      content: assistantPrefill,
    });
  } else if (
    ctx.generationType === "continue" &&
    result.length > 0 &&
    result[result.length - 1].role === "assistant"
  ) {
    // Continue generation with no explicit prefill — add a minimal nudge so the
    // conversation ends on a user message (required by most providers).
    result.push({ role: "user", content: "[Continue]" });
    breakdown.push({
      type: "utility",
      name: "User Nudge",
      role: "user",
      content: "[Continue]",
    });
  }

  // ---- Apply CompletionSettings post-processing ----
  applyCompletionSettings(
    result,
    completionSettings,
    character,
    persona,
    ctx.generationType,
  );

  // ---- Apply pending append blocks ----
  // Group appends by target (baseRole + depth) so every append for the same
  // target message is applied in a single atomic operation, preserving relative
  // order from the preset's prompt_order and all intermediate whitespace.
  const appendGroups = new Map<string, PendingAppend[]>();
  for (const append of pendingAppends) {
    const key = `${append.baseRole}:${append.depth}`;
    let group = appendGroups.get(key);
    if (!group) {
      group = [];
      appendGroups.set(key, group);
    }
    group.push(append);
  }
  for (const group of appendGroups.values()) {
    applyAppendGroup(result, breakdown, group);
  }

  // Strip trailing whitespace from the last chat-history assistant message.
  // Anthropic (and other strict providers) reject turns ending in whitespace;
  // explicit prefills are left alone so users can intentionally seed responses.
  rtrimLastHistoryAssistant(result);

  // Drop blank text parts from multipart messages — caption-less attachments,
  // fully-stripped regex output, etc. can otherwise produce empty content blocks
  // that Anthropic/Vertex-Anthropic reject with "text content blocks must
  // contain non-whitespace text".
  stripEmptyTextParts(result);

  // ---- Collapse all messages into a single user message (if enabled) ----
  const advSettings: AdvancedSettings | undefined = prompts.advancedSettings;
  if (advSettings?.collapseMessages) {
    collapseToSingleUserMessage(result);
  }

  // ---- Build parameters from sampler overrides + advanced settings + reasoning + custom body ----
  const parameters = buildParameters(
    samplerOverrides,
    preset,
    reasoningVal,
    connection?.provider,
    connection?.model,
  );

  // Include Usage: internal flag so providers request token usage data in streams
  if (completionSettings.includeUsage) {
    parameters._include_usage = true;
  }

  // ---- Context budget clipping ----
  // Drop oldest chat history messages until the assembly fits under the
  // configured `max_context_length` (minus response headroom + safety margin).
  // Runs AFTER all WI / AN / depth / prefill insertions so fixed overhead is
  // accurately measured. The breakdown recompute below picks up the new
  // chat-history bounds from the mutated `result` array.
  // Yield before the sync tokenization loop below — on long chats this can
  // count thousands of messages in a tight loop and monopolise the event loop.
  await yieldAndCheckAbort(ctx.signal);
  const contextClipStats = await clipToContextBudget(
    result,
    connection?.model ?? null,
    parameters.max_context_length as number | null | undefined,
    parameters.max_tokens as number | null | undefined,
    ctx.signal,
  );

  // Build memory stats for dry-run diagnostics
  const memoryStats: MemoryStats = {
    enabled: memoryResult.enabled,
    chunksRetrieved: memoryResult.count,
    chunksAvailable: memoryResult.chunksAvailable,
    chunksPending: memoryResult.chunksPending,
    injectionMethod: !memoryResult.enabled
      ? "disabled"
      : macroHandlesMemory
        ? "macro"
        : "fallback",
    retrievedChunks: memoryResult.chunks.map((c) => ({
      score: c.score,
      tokenEstimate: Math.ceil(c.content.length / 4),
      messageRange: [
        c.metadata?.startIndex ?? 0,
        c.metadata?.endIndex ?? 0,
      ] as [number, number],
      preview: c.content,
    })),
    queryPreview: memoryResult.queryPreview,
    settingsSource: memoryResult.settingsSource,
  };
  const databankStats: DatabankStats = {
    enabled: activeDatabankIds.length > 0,
    embeddingsEnabled: databankEmbCfg.enabled,
    activeBankCount: activeDatabankIds.length,
    activeDatabankIds,
    chunksRetrieved: databankResult.count,
    injectionMethod:
      activeDatabankIds.length === 0 || !databankEmbCfg.enabled
        ? "disabled"
        : databankResult.count > 0
          ? macroHandlesDatabank
            ? "macro"
            : "fallback"
          : "none",
    retrievalState: databankRetrievalState,
    retrievedChunks: databankResult.chunks.map((c) => ({
      score: c.score,
      tokenEstimate: Math.ceil(c.content.length / 4),
      documentName: c.documentName,
      databankId: c.databankId,
      preview: c.content,
    })),
    queryPreview: databankQueryPreview,
  };

  // Recompute the chat_history breakdown entry's bounds from the actual final
  // message positions. The entry was pushed during the chat history loop with
  // pre-mutation values; downstream insertions (WI before/AN before/EM
  // before/depth-injected blocks/Author's Note/depth blocks) and mutations
  // (mergeConsecutiveUserMessages) shift indices and change counts.
  // Without this, regex-script depth filtering and the tokenizer snapshot in
  // generate.service.ts would use stale bounds and either skip messages they
  // should match or include non-history messages they shouldn't.
  const chatHistoryEntry = breakdown.find((e) => e.type === "chat_history");
  if (chatHistoryEntry) {
    let firstIdx = -1;
    let count = 0;
    for (let i = 0; i < result.length; i++) {
      if (isChatHistoryMessage(result[i])) {
        if (firstIdx === -1) firstIdx = i;
        count++;
      }
    }
    chatHistoryEntry.firstMessageIndex = firstIdx >= 0 ? firstIdx : undefined;
    chatHistoryEntry.messageCount = count;
    // Clip already tokenized every remaining history message with the same
    // model → same tokenizer as countBreakdown will resolve. Hand the sum
    // over so the downstream snapshot doesn't retokenize.
    if (contextClipStats.enabled && !contextClipStats.budgetInvalid) {
      chatHistoryEntry.preCountedTokens =
        contextClipStats.chatHistoryTokensAfter;
    }
  }

  return {
    messages: result,
    breakdown,
    parameters,
    assistantPrefill,
    activatedWorldInfo:
      activatedWorldInfo.length > 0 ? activatedWorldInfo : undefined,
    worldInfoStats,
    memoryStats,
    databankStats,
    contextClipStats,
    deferredWiState,
    deliberationHandledByMacro: !!(macroEnv.extra as any)
      ._deliberationMacroUsed,
    macroEnv,
  };
}

function normalizeGuidedGenerations(input: unknown): GuidedGeneration[] {
  if (!Array.isArray(input)) return [];
  const out: GuidedGeneration[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const g = item as Partial<GuidedGeneration>;
    if (!g.enabled) continue;
    if (typeof g.content !== "string" || !g.content.trim()) continue;
    const position =
      g.position === "user_prefix" || g.position === "user_suffix"
        ? g.position
        : "system";
    out.push({
      id: typeof g.id === "string" ? g.id : "",
      name:
        typeof g.name === "string" && g.name.trim()
          ? g.name
          : "Guided Generation",
      content: g.content,
      position,
      mode: g.mode === "oneshot" ? "oneshot" : "persistent",
      enabled: true,
    });
  }
  return out;
}

async function applyGuidedGenerations(
  result: LlmMessage[],
  guides: GuidedGeneration[],
  macroEnv: MacroEnv,
  breakdown: AssemblyBreakdownEntry[],
): Promise<void> {
  const systemInjections: string[] = [];
  const prefixes: string[] = [];
  const suffixes: string[] = [];

  for (const guide of guides) {
    const resolved = (
      await evaluate(guide.content, macroEnv, registry)
    ).text.trim();
    if (!resolved) continue;
    if (guide.position === "system") systemInjections.push(resolved);
    if (guide.position === "user_prefix") prefixes.push(resolved);
    if (guide.position === "user_suffix") suffixes.push(resolved);
  }

  if (systemInjections.length > 0) {
    const insertIdx = result.findIndex((m) => m.role !== "system");
    result.splice(insertIdx >= 0 ? insertIdx : result.length, 0, {
      role: "system",
      content: systemInjections.join("\n\n"),
    });
    breakdown.push({
      type: "utility",
      name: "Guided Generations (system)",
      role: "system",
      content: systemInjections.join("\n\n"),
    });
  }

  if (prefixes.length > 0 || suffixes.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role !== "user") continue;
      const prefix = prefixes.length > 0 ? `${prefixes.join("\n")}\n` : "";
      const suffix = suffixes.length > 0 ? `\n${suffixes.join("\n")}` : "";
      if (typeof result[i].content === "string") {
        result[i] = {
          ...result[i],
          content: `${prefix}${result[i].content}${suffix}`,
        };
      } else {
        // Multipart: prepend/append to the text part
        const parts = [
          ...(result[i].content as import("../llm/types").LlmMessagePart[]),
        ];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
          parts[textIdx] = {
            type: "text",
            text: `${prefix}${tp.text}${suffix}`,
          };
        } else {
          parts.unshift({ type: "text", text: `${prefix}${suffix}` });
        }
        result[i] = { ...result[i], content: parts };
      }
      breakdown.push({
        type: "utility",
        name: "Guided Generations (user)",
        role: "user",
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Lumia / Loom context loader
// ---------------------------------------------------------------------------

/**
 * Load all Lumia, Loom, Council, OOC, and Sovereign Hand settings and inject
 * them into macroEnv.extra so the lumia/loom macro definitions can read them.
 *
 * When `settingsMap` is provided (from batch load), settings are read from it
 * instead of individual DB queries.
 */
export function populateLumiaLoomContext(
  macroEnv: MacroEnv,
  userId: string,
  chat: Chat,
  ctx?: AssemblyContext,
  settingsMap?: Map<string, any>,
): void {
  // Helper to read from batch map or fall back to individual query
  const s = (key: string, fallback: any = null) => {
    if (settingsMap) return settingsMap.get(key) ?? fallback;
    return settingsSvc.getSetting(userId, key)?.value ?? fallback;
  };

  // ---- Lumia selections (persisted by frontend as full LumiaItem objects) ----
  const selectedDef = s("selectedDefinition");
  const selectedChimeraDefinitions = s("selectedChimeraDefinitions", []);
  const selectedBehaviors = s("selectedBehaviors", []);
  const selectedPersonalities = s("selectedPersonalities", []);
  const chimeraMode = s("chimeraMode", false);

  // ---- Quirks ----
  const lumiaQuirks = s("lumiaQuirks", "");
  const lumiaQuirksEnabled = s("lumiaQuirksEnabled", true);

  // ---- OOC ----
  const oocEnabled = s("oocEnabled", true);
  const lumiaOOCInterval = s("lumiaOOCInterval");
  const lumiaOOCStyle = s("lumiaOOCStyle", "social");

  // ---- Sovereign Hand ----
  const sovereignHand = s("sovereignHand", {
    enabled: false,
    excludeLastMessage: true,
    includeMessageInPrompt: true,
  });

  // ---- Council ----
  const councilSettings = councilProfilesSvc.resolveProfile(
    userId,
    chat.id,
    chat.character_id,
    { isGroup: chat.metadata?.group === true },
  ).council_settings;

  // Batch-load full Lumia items for council members (single query)
  const memberItemIds = councilSettings.members.map((m: any) => m.itemId);
  const memberItemsMap =
    memberItemIds.length > 0
      ? packsSvc.getLumiaItemsByIds(userId, memberItemIds)
      : new Map<string, any>();
  const memberItems: Record<string, any> = {};
  for (const [id, item] of memberItemsMap) {
    memberItems[id] = item;
  }

  // ---- Loom selections (may not exist yet — future frontend feature) ----
  const selectedLoomStyles = s("selectedLoomStyles", []);
  const selectedLoomUtils = s("selectedLoomUtils", []);
  const selectedLoomRetrofits = s("selectedLoomRetrofits", []);

  // ---- Loom summary from chat metadata ----
  const loomSummary = (chat.metadata?.loom_summary as string) ?? "";

  // ---- Lazy-load all Lumia items (only fetched if {{randomLumia}} is evaluated) ----
  let _allLumiaItems: any[] | null = null;
  const allItemsLoader = () => {
    if (_allLumiaItems === null)
      _allLumiaItems = packsSvc.getAllLumiaItems(userId);
    return _allLumiaItems;
  };

  // ---- Inject into env.extra ----
  macroEnv.extra.lumia = {
    selectedDefinition: selectedDef,
    selectedChimeraDefinitions,
    selectedBehaviors,
    selectedPersonalities,
    chimeraMode,
    quirks: lumiaQuirks,
    quirksEnabled: lumiaQuirksEnabled,
    get allItems() {
      return allItemsLoader();
    },
  };

  macroEnv.extra.loom = {
    selectedStyles: selectedLoomStyles,
    selectedUtils: selectedLoomUtils,
    selectedRetrofits: selectedLoomRetrofits,
    summary: loomSummary,
  };

  macroEnv.extra.council = {
    councilMode: councilSettings.councilMode,
    members: councilSettings.members,
    toolsSettings: councilSettings.toolsSettings,
    memberItems,
    // Council tool results — injected from AssemblyContext if available
    toolResults: ctx?.councilToolResults ?? [],
    namedResults: ctx?.councilNamedResults ?? {},
  };

  macroEnv.extra.ooc = {
    enabled: oocEnabled,
    interval: lumiaOOCInterval,
    style: lumiaOOCStyle,
  };

  macroEnv.extra.sovereignHand = sovereignHand;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type BookSource = "character" | "persona" | "chat" | "global";

/**
 * Collect all WorldBookEntry[] from character extensions + persona attached book.
 */
function collectWorldInfoEntries(
  userId: string,
  character: Character,
  persona: Persona | null,
  globalWorldBookIds?: string[],
  chatWorldBookIds?: string[],
): import("../types/world-book").WorldBookEntry[] {
  return collectWorldInfoSources(
    userId,
    character,
    persona,
    globalWorldBookIds,
    chatWorldBookIds,
  ).entries;
}

export function collectWorldInfoSources(
  userId: string,
  character: Character,
  persona: Persona | null,
  globalWorldBookIds?: string[],
  chatWorldBookIds?: string[],
): {
  entries: import("../types/world-book").WorldBookEntry[];
  worldBookIds: string[];
  bookSourceMap: Map<string, BookSource>;
} {
  const worldBookIds: string[] = [];
  const bookSourceMap = new Map<string, BookSource>();
  const seen = new Set<string>();

  const pushBook = (id: string | null | undefined, source: BookSource) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    worldBookIds.push(id);
    bookSourceMap.set(id, source);
  };

  // Collect in priority order: character → persona → chat → global.
  // Source attribution keeps the first (narrowest) winner.
  for (const charBookId of getCharacterWorldBookIds(character.extensions)) {
    pushBook(charBookId, "character");
  }
  pushBook(persona?.attached_world_book_id, "persona");
  for (const cId of chatWorldBookIds ?? []) pushBook(cId, "chat");
  for (const gId of globalWorldBookIds ?? []) pushBook(gId, "global");

  // Batch-load all books in a single pair of queries. With large books
  // (thousands of entries each), this avoids the N+1 round-trip cost of
  // calling listEntries() once per attached book.
  const entries: import("../types/world-book").WorldBookEntry[] = [];
  if (worldBookIds.length > 0) {
    const entryMap = worldBooksSvc.listEntriesForBooks(userId, worldBookIds);
    const embeddedCharacterBook = character.extensions?.character_book;
    // Preserve original per-book ordering (character → persona → chat → global).
    for (const id of worldBookIds) {
      const bookEntries = entryMap.get(id);
      if (bookEntries && bookEntries.length > 0) {
        entries.push(...bookEntries);
        continue;
      }

      if (!embeddedCharacterBook) continue;

      const book = worldBooksSvc.getWorldBook(userId, id);
      if (
        book?.metadata?.source === "character" &&
        book.metadata?.source_character_id === character.id
      ) {
        entries.push(
          ...worldBooksSvc.materializeCharacterBookEntriesForRuntime(
            id,
            embeddedCharacterBook,
          ),
        );
      }
    }
  }

  return {
    entries,
    worldBookIds,
    bookSourceMap,
  };
}

type WorldBookEntryModel = import("../types/world-book").WorldBookEntry;
type HybridWeightMode =
  import("./embeddings.service").EmbeddingConfig["hybrid_weight_mode"];

interface WorldInfoVectorRankingPreset {
  candidateMultiplier: number;
  weights: {
    vector: number;
    primaryExact: number;
    primaryPartial: number;
    secondaryExact: number;
    secondaryPartial: number;
    commentExact: number;
    commentPartial: number;
    priority: number;
    broadPenalty: number;
  };
}

interface PhraseSpecificityState {
  totalEntries: number;
  phraseDocFrequency: Map<string, number>;
  tokenDocFrequency: Map<string, number>;
}

interface VectorQueryLexicalState {
  normalizedText: string;
  tokenSet: Set<string>;
  focusTokenSet: Set<string>;
  specificityState: PhraseSpecificityState;
}

export interface VectorScoreBreakdown {
  vectorSimilarity: number;
  lexicalContentBoost: number;
  primaryExact: number;
  primaryPartial: number;
  secondaryExact: number;
  secondaryPartial: number;
  commentExact: number;
  commentPartial: number;
  focusBoost: number;
  priority: number;
  broadPenalty: number;
  focusMissPenalty: number;
}

export interface VectorActivatedEntry {
  entry: WorldBookEntryModel;
  score: number;
  distance: number;
  finalScore: number;
  lexicalCandidateScore: number | null;
  matchedPrimaryKeys: string[];
  matchedSecondaryKeys: string[];
  matchedComment: string | null;
  scoreBreakdown: VectorScoreBreakdown;
  searchTextPreview: string;
}

export interface VectorWorldInfoRetrievalResult {
  entries: VectorActivatedEntry[];
  candidateTrace: VectorRetrievalTraceEntry[];
  queryPreview: string;
  eligibleCount: number;
  hitsBeforeThreshold: number;
  hitsAfterThreshold: number;
  thresholdRejected: number;
  hitsAfterRerankCutoff: number;
  rerankRejected: number;
  topK: number;
  cap: number;
  blockerMessages: string[];
}

export type VectorRetrievalTraceStage =
  | "shortlisted"
  | "trimmed_by_top_k"
  | "rejected_by_rerank_cutoff"
  | "rejected_by_similarity_threshold";

export interface VectorRetrievalTraceEntry extends VectorActivatedEntry {
  retrievalStage: VectorRetrievalTraceStage;
  rerankRank: number | null;
}

export interface MergedWorldInfoEntriesResult {
  cache: WorldInfoCache;
  activatedEntries: WorldBookEntryModel[];
  activatedWorldInfo: ActivatedWorldInfoEntry[];
  keywordActivated: number;
  vectorActivated: number;
  totalActivated: number;
  estimatedTokens: number;
  activatedBeforeBudget: number;
  activatedAfterBudget: number;
  evictedByBudget: number;
  deduplicated: number;
  deduplicationDetails: import("./world-info-dedup.service").DedupRemovalRecord[];
}

export async function resolveWorldInfoOutlets(
  entries: WorldBookEntryModel[],
  macroEnv: MacroEnv,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const templates = new Map<string, string>();

  for (const entry of entries) {
    const outletName = normalizeWorldInfoOutletName(entry.outlet_name);
    if (!outletName) continue;
    if (typeof entry.content !== "string" || entry.content.trim().length === 0)
      continue;
    if (templates.has(outletName)) {
      templates.set(
        outletName,
        templates.get(outletName) + "\n\n" + entry.content,
      );
    } else {
      templates.set(outletName, entry.content);
    }
  }

  if (templates.size === 0) {
    macroEnv.extra.worldInfoOutlets = {};
    return macroEnv.extra.worldInfoOutlets as Record<string, string>;
  }

  const resolved = new Map<string, string>(templates);
  macroEnv.extra.worldInfoOutlets = Object.fromEntries(resolved);

  // Build a dependency map: for each template, record which outlet names it
  // references via {{outlet::name}}. On subsequent passes we only re-evaluate
  // templates that depend on an outlet whose resolved value changed.
  const dependsOn = new Map<string, Set<string>>();
  for (const [name, template] of templates) {
    const deps = new Set<string>();
    const outletPattern = /\{\{outlet::([^}]+)\}\}/gi;
    let match: RegExpExecArray | null;
    while ((match = outletPattern.exec(template)) !== null) {
      const dep = match[1].trim().toLowerCase();
      if (dep && dep !== name.toLowerCase()) deps.add(dep);
    }
    dependsOn.set(name, deps);
  }

  // Track which outlets changed in the previous pass. On pass 0, evaluate all.
  let changedOutlets: Set<string> | null = null; // null = evaluate all

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    let index = 0;
    const newlyChanged = new Set<string>();

    for (const [name, template] of templates) {
      if ((index++ & 15) === 0) {
        await yieldAndCheckAbort(signal);
      } else if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      // On passes after the first, skip templates that don't depend on any
      // outlet that changed in the previous pass.
      if (changedOutlets !== null) {
        const deps = dependsOn.get(name);
        if (deps && deps.size > 0) {
          let hasDirtyDep = false;
          for (const dep of deps) {
            if (changedOutlets.has(dep)) {
              hasDirtyDep = true;
              break;
            }
          }
          if (!hasDirtyDep) continue;
        } else if (deps) {
          // No deps and not the first pass — skip
          continue;
        }
      }

      const next = (await evaluate(template, macroEnv, registry)).text;
      if (resolved.get(name) !== next) {
        resolved.set(name, next);
        changed = true;
        newlyChanged.add(name.toLowerCase());
      }
    }

    macroEnv.extra.worldInfoOutlets = Object.fromEntries(resolved);
    if (!changed) break;
    // Next pass only re-evaluates templates that depend on outlets changed THIS pass
    changedOutlets = newlyChanged;
  }

  return macroEnv.extra.worldInfoOutlets as Record<string, string>;
}

const WORLD_INFO_VECTOR_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "was",
  "were",
  "with",
  "you",
  "your",
]);

const WORLD_INFO_FOCUS_GENERIC_TOKENS = new Set([
  "angel",
  "angels",
  "demon",
  "demons",
  "king",
  "spirit",
  "spirits",
  "astral",
  "dress",
  "first",
  "true",
  "special",
  "service",
  "team",
  "unit",
  "force",
  "forces",
  "group",
  "protocol",
  "framework",
  "mechanics",
  "classification",
  "ranks",
  "rank",
  "codename",
  "operations",
  "operation",
  "alarm",
  "date",
  "goal",
  "goals",
  "state",
  "form",
  "city",
  "world",
  "public",
  "perception",
  "history",
  "arc",
  "post",
  "rules",
  "rule",
]);

const WORLD_INFO_REFERENCE_TITLE_KEYWORDS = new Set([
  "relationship",
  "protocol",
  "framework",
  "mechanics",
  "classification",
  "ranks",
  "rank",
  "codename",
  "perception",
  "alarm",
  "operations",
  "operation",
  "goal",
  "goals",
  "founders",
  "cooking",
  "conflict",
  "date",
  "post",
  "history",
  "arc",
]);

const WORLD_INFO_REFERENCE_CONTENT_PATTERNS = [
  /\brelationship\s*:/i,
  /\bsection_/i,
  /\bsubsection_/i,
  /\belement_/i,
  /\bframework_/i,
  /\bofficial_narrative\b/i,
  /\bnarrative_function\b/i,
  /\bgoal_&_philosophy\b/i,
  /\brule\s*:/i,
  /\boverview\(/i,
] as const;

const WORLD_INFO_SUBJECT_FIELD_PATTERNS = [
  /\b(?:user|wielder|owner|pilot|host|bearer|contractor)\(([^)]+)\)/gi,
] as const;

const WORLD_INFO_VECTOR_PRESETS: Record<
  HybridWeightMode,
  WorldInfoVectorRankingPreset
> = {
  keyword_first: {
    candidateMultiplier: 4,
    weights: {
      vector: 0.6,
      primaryExact: 0.7,
      primaryPartial: 0.3,
      secondaryExact: 0.4,
      secondaryPartial: 0.16,
      commentExact: 0.15,
      commentPartial: 0.055,
      priority: 0.08,
      broadPenalty: 0.05,
    },
  },
  balanced: {
    candidateMultiplier: 3,
    weights: {
      vector: 0.8,
      primaryExact: 0.55,
      primaryPartial: 0.24,
      secondaryExact: 0.28,
      secondaryPartial: 0.12,
      commentExact: 0.1,
      commentPartial: 0.035,
      priority: 0.06,
      broadPenalty: 0.07,
    },
  },
  vector_first: {
    candidateMultiplier: 2,
    weights: {
      vector: 1.0,
      primaryExact: 0.4,
      primaryPartial: 0.18,
      secondaryExact: 0.18,
      secondaryPartial: 0.08,
      commentExact: 0.07,
      commentPartial: 0.02,
      priority: 0.04,
      broadPenalty: 0.08,
    },
  },
};

function incrementFrequency(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function buildPhraseSpecificityState(
  entries: WorldBookEntryModel[],
): PhraseSpecificityState {
  const phraseDocFrequency = new Map<string, number>();
  const tokenDocFrequency = new Map<string, number>();

  for (const entry of entries) {
    // Fast-path: entries with no lexical signals (no keys / keysecondary /
    // comment) contribute nothing to either frequency map. In large
    // vector-only lorebooks (e.g. 9000+ entries with key=[]), skipping the
    // allocation of two empty Sets + three empty-string normalizations per
    // entry is the difference between a ~1s build and a ~30ms one.
    const keys = entry.key;
    const secondaries = entry.keysecondary;
    const comment = entry.comment;
    const hasKeys = keys && keys.length > 0;
    const hasSecondaries = secondaries && secondaries.length > 0;
    const hasComment = !!(comment && comment.length > 0);
    if (!hasKeys && !hasSecondaries && !hasComment) continue;

    const entryPhrases = new Set<string>();
    const entryTokens = new Set<string>();

    const ingest = (value: string) => {
      const normalizedValue = normalizeLexicalText(value);
      if (!normalizedValue) return;
      entryPhrases.add(normalizedValue);
      for (const token of tokenizeLexicalText(value)) {
        entryTokens.add(token);
      }
    };

    if (hasKeys) for (const value of keys) ingest(value);
    if (hasSecondaries) for (const value of secondaries) ingest(value);
    if (hasComment) ingest(comment);

    for (const phrase of entryPhrases) {
      incrementFrequency(phraseDocFrequency, phrase);
    }

    for (const token of entryTokens) {
      incrementFrequency(tokenDocFrequency, token);
    }
  }

  return {
    totalEntries: Math.max(1, entries.length),
    phraseDocFrequency,
    tokenDocFrequency,
  };
}

function normalizeLexicalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLexicalText(text: string): string[] {
  return normalizeLexicalText(text)
    .split(" ")
    .filter(
      (token) => token.length > 1 && !WORLD_INFO_VECTOR_STOPWORDS.has(token),
    );
}

function dedupeStringsCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function hasExactPhraseMatch(normalizedText: string, value: string): boolean {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedText || !normalizedValue) return false;
  return ` ${normalizedText} `.includes(` ${normalizedValue} `);
}

function getPhraseTokenOverlap(tokenSet: Set<string>, value: string): number {
  const tokens = tokenizeLexicalText(value);
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) matched += 1;
  }
  return matched / tokens.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distanceToSimilarity(distance: number): number {
  return Math.exp(-1.5 * Math.max(0, distance));
}

function getInverseFrequencyScore(
  totalEntries: number,
  documentFrequency: number,
): number {
  if (totalEntries <= 1) return 1;
  const clampedFrequency = Math.max(
    1,
    Math.min(documentFrequency, totalEntries),
  );
  return clamp01(
    Math.log((totalEntries + 1) / clampedFrequency) /
      Math.log(totalEntries + 1),
  );
}

function getTokenSpecificity(
  state: PhraseSpecificityState,
  token: string,
): number {
  return getInverseFrequencyScore(
    state.totalEntries,
    state.tokenDocFrequency.get(token) ?? state.totalEntries,
  );
}

function getPhraseSpecificity(
  state: PhraseSpecificityState,
  value: string,
): number {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedValue) return 0;

  const tokens = tokenizeLexicalText(value);
  if (tokens.length === 0) return 0;

  const phraseSpecificity = getInverseFrequencyScore(
    state.totalEntries,
    state.phraseDocFrequency.get(normalizedValue) ?? state.totalEntries,
  );
  const tokenSpecificity =
    tokens.reduce(
      (sum, token) =>
        sum +
        getInverseFrequencyScore(
          state.totalEntries,
          state.tokenDocFrequency.get(token) ?? state.totalEntries,
        ),
      0,
    ) / tokens.length;

  const baseSpecificity =
    tokens.length === 1
      ? tokenSpecificity
      : phraseSpecificity * 0.55 + tokenSpecificity * 0.45;
  const tokenCountFactor =
    tokens.length >= 3 ? 1 : tokens.length === 2 ? 0.94 : 0.82;
  const lengthFactor =
    normalizedValue.length >= 10
      ? 1
      : normalizedValue.length >= 6
        ? 0.92
        : 0.84;

  return clamp01(
    Math.max(0.08, baseSpecificity * tokenCountFactor * lengthFactor),
  );
}

function getPhraseSignalStrength(
  specificity: number,
  value: string,
  kind: "key" | "comment",
): number {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedValue || specificity <= 0) return 0;

  const tokenCount = tokenizeLexicalText(value).length;
  if (tokenCount !== 1) return specificity;

  const lengthFactor =
    normalizedValue.length >= 11
      ? 0.92
      : normalizedValue.length >= 8
        ? 0.82
        : 0.72;
  const rarityFactor =
    kind === "comment" ? 0.32 + specificity * 0.58 : 0.4 + specificity * 0.5;
  const kindFactor = kind === "comment" ? 0.74 : 0.8;

  return clamp01(specificity * lengthFactor * rarityFactor * kindFactor);
}

function getPartialMatchThreshold(
  value: string,
  kind: "key" | "comment",
): number {
  const tokenCount = tokenizeLexicalText(value).length;
  if (tokenCount <= 1) return 1;
  if (kind === "comment") return tokenCount === 2 ? 0.85 : 0.75;
  return tokenCount === 2 ? 0.75 : 0.6;
}

function getRareTokenPartialScore(
  value: string,
  queryState: VectorQueryLexicalState,
  partialWeight: number,
  kind: "key" | "comment",
): number {
  const tokens = Array.from(new Set(tokenizeLexicalText(value)));
  if (tokens.length < 2) return 0;

  const matchedTokenSpecificities = tokens
    .filter((token) => queryState.tokenSet.has(token))
    .map((token) => getTokenSpecificity(queryState.specificityState, token));
  if (matchedTokenSpecificities.length === 0) return 0;

  const bestTokenSpecificity = Math.max(...matchedTokenSpecificities);
  const minimumSpecificity = kind === "comment" ? 0.42 : 0.34;
  if (bestTokenSpecificity < minimumSpecificity) return 0;

  const averageMatchedSpecificity =
    matchedTokenSpecificities.reduce(
      (sum, specificity) => sum + specificity,
      0,
    ) / matchedTokenSpecificities.length;
  const matchedCoverage = matchedTokenSpecificities.length / tokens.length;
  const coverageFactor = 0.48 + matchedCoverage * 0.52;
  const shapeFactor =
    tokens.length === 2 ? 0.92 : tokens.length === 3 ? 0.88 : 0.84;

  return (
    partialWeight *
    (bestTokenSpecificity * 0.72 + averageMatchedSpecificity * 0.28) *
    coverageFactor *
    shapeFactor
  );
}

function countPatternMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches?.length ?? 0;
}

function estimateReferenceEntryPenalty(
  entry: WorldBookEntryModel,
  candidateDistance: number,
  lexicalSpecificityAnchor: number,
  primaryMatches: { exactScore: number; partialScore: number },
  secondaryMatches: { exactScore: number; partialScore: number },
  commentMatches: { exactScore: number; partialScore: number },
): number {
  const content = entry.content || "";
  const title = entry.comment || "";
  const titleTokens = tokenizeLexicalText(title);
  const contentTokenCount = tokenizeLexicalText(content).length;
  const titleTokenCount = titleTokens.length;
  const fieldPatternCount = countPatternMatches(
    content,
    /\b[a-z][a-z0-9_]{2,}\s*\(/gi,
  );
  const semicolonCount = countPatternMatches(content, /;/g);
  const listMarkerCount = countPatternMatches(content, /^\s*[-*]/gm);

  const lengthPenalty = clamp01((contentTokenCount - 90) / 260);
  const structurePenalty = clamp01(
    clamp01(fieldPatternCount / 14) * 0.55 +
      clamp01(semicolonCount / 22) * 0.35 +
      clamp01(listMarkerCount / 8) * 0.1,
  );
  const singleTokenTitlePenalty = titleTokenCount === 1 ? 0.08 : 0;
  const hasKeyMatch =
    primaryMatches.exactScore > 0 ||
    primaryMatches.partialScore > 0 ||
    secondaryMatches.exactScore > 0 ||
    secondaryMatches.partialScore > 0;
  const hasCommentMatch =
    commentMatches.exactScore > 0 || commentMatches.partialScore > 0;
  const commentOnlyMatch = hasCommentMatch && !hasKeyMatch;
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const acronymTitle = /\b[A-Z]{2,}\b/.test(title);
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );
  const vectorWeakness = clamp01((candidateDistance - 0.9) / 0.45);
  const lexicalConfidence = clamp01(
    lexicalSpecificityAnchor * 0.68 +
      (commentMatches.exactScore > 0 ? 0.08 : 0) +
      (primaryMatches.exactScore > 0 ? 0.18 : 0) +
      (secondaryMatches.exactScore > 0 ? 0.12 : 0) +
      (commentMatches.partialScore > 0 ? 0.04 : 0) +
      (primaryMatches.partialScore > 0 ? 0.08 : 0) +
      (secondaryMatches.partialScore > 0 ? 0.05 : 0),
  );
  const titleMetaPenalty = hasCommentMatch
    ? clamp01(
        (relationshipStyleTitle ? 1 : 0) * 0.9 +
          clamp01(referenceKeywordCount / 2) * 0.48 +
          clamp01(referenceContentSignalCount / 3) * 0.34,
      ) *
      (commentOnlyMatch ? 1 : 0.45) *
      (0.3 + vectorWeakness * 0.7) *
      (commentMatches.exactScore > 0 ? 1 : 0.82)
    : 0;
  const structurePenaltyWithConfidence =
    clamp01(
      lengthPenalty * 0.3 + structurePenalty * 0.6 + singleTokenTitlePenalty,
    ) *
    (1 - lexicalConfidence);
  const titlePenaltyWithConfidence =
    titleMetaPenalty * Math.max(0.18, 0.72 - lexicalConfidence * 0.32);
  const relationshipPenalty = relationshipStyleTitle
    ? (commentMatches.exactScore > 0 ? 0.04 : 0.026) *
      (commentOnlyMatch ? 1 : 0.65) *
      (0.35 + vectorWeakness * 0.65)
    : 0;
  const parentheticalMetaPenalty =
    parentheticalMetaTitle && !hasKeyMatch
      ? (commentMatches.partialScore > 0 && commentMatches.exactScore === 0
          ? 0.028
          : 0.014) *
        (commentOnlyMatch ? 1 : 0.75) *
        (0.28 + vectorWeakness * 0.72)
      : 0;
  const acronymPenalty =
    acronymTitle && !hasKeyMatch && !hasCommentMatch
      ? 0.02 + vectorWeakness * 0.035
      : 0;

  return clamp01(
    structurePenaltyWithConfidence +
      titlePenaltyWithConfidence +
      relationshipPenalty +
      parentheticalMetaPenalty +
      acronymPenalty,
  );
}

function buildFocusTokenSet(
  queryText: string,
  specificityState: PhraseSpecificityState,
): Set<string> {
  const queryTokenSignals = new Map<
    string,
    { count: number; hasNameLikeForm: boolean; hasUppercaseForm: boolean }
  >();
  for (const match of queryText.matchAll(/\b[A-Za-z0-9]+\b/g)) {
    const rawToken = match[0];
    const normalizedToken = normalizeLexicalText(rawToken);
    if (
      !normalizedToken ||
      WORLD_INFO_VECTOR_STOPWORDS.has(normalizedToken) ||
      normalizedToken.length <= 1
    ) {
      continue;
    }

    const previous = queryTokenSignals.get(normalizedToken) ?? {
      count: 0,
      hasNameLikeForm: false,
      hasUppercaseForm: false,
    };
    const isUppercaseForm =
      /[A-Z]/.test(rawToken) && rawToken === rawToken.toUpperCase();
    const isNameLikeForm = isUppercaseForm || /^[A-Z][a-z0-9]+$/.test(rawToken);

    queryTokenSignals.set(normalizedToken, {
      count: previous.count + 1,
      hasNameLikeForm: previous.hasNameLikeForm || isNameLikeForm,
      hasUppercaseForm: previous.hasUppercaseForm || isUppercaseForm,
    });
  }

  const tokens = tokenizeLexicalText(queryText);
  return new Set(
    tokens.filter((token) => {
      if (!token || WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) return false;

      const signal = queryTokenSignals.get(token);
      if (!signal) return false;

      const specificity = getTokenSpecificity(specificityState, token);
      const repeated = signal.count >= 2 && token.length >= 4;
      const named = signal.hasNameLikeForm && token.length >= 3;
      const uppercase = signal.hasUppercaseForm && token.length >= 2;
      const verySpecificLongToken = token.length >= 8 && specificity >= 0.48;

      if (uppercase) return true;
      if (named && specificity >= 0.24) return true;
      if (repeated && specificity >= 0.3) return true;
      if (verySpecificLongToken) return true;
      return false;
    }),
  );
}

function getEntryFocusOverlap(
  entry: WorldBookEntryModel,
  queryState: VectorQueryLexicalState,
): { count: number; score: number } {
  if (queryState.focusTokenSet.size === 0) {
    return { count: 0, score: 0 };
  }

  const title = entry.comment || "";
  const content = entry.content || "";
  const titleTokens = tokenizeLexicalText(title);
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );

  const entryTokens = new Set<string>();
  const lexicalValues = [
    ...(entry.key || []),
    ...(entry.keysecondary || []),
    title,
  ];

  for (const value of lexicalValues) {
    for (const token of tokenizeLexicalText(value)) {
      if (WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) continue;
      entryTokens.add(token);
    }
  }

  const matchedSpecificities: number[] = [];
  for (const token of entryTokens) {
    if (!queryState.focusTokenSet.has(token)) continue;
    matchedSpecificities.push(
      getTokenSpecificity(queryState.specificityState, token),
    );
  }

  if (matchedSpecificities.length === 0) {
    return { count: 0, score: 0 };
  }

  const isReferenceStyleEntry =
    relationshipStyleTitle ||
    parentheticalMetaTitle ||
    referenceKeywordCount > 0 ||
    referenceContentSignalCount > 0;
  const bestSpecificity = Math.max(...matchedSpecificities);
  if (matchedSpecificities.length === 1 && bestSpecificity < 0.58) {
    return { count: 0, score: 0 };
  }

  const averageSpecificity =
    matchedSpecificities.reduce((sum, value) => sum + value, 0) /
    matchedSpecificities.length;
  const coverage =
    matchedSpecificities.length / Math.min(3, queryState.focusTokenSet.size);
  const rawScore = clamp01(
    (bestSpecificity * 0.62 + averageSpecificity * 0.38) *
      (0.45 + clamp01(coverage) * 0.55),
  );

  if (isReferenceStyleEntry) {
    return {
      count: matchedSpecificities.length,
      score: 0,
    };
  }

  return {
    count: matchedSpecificities.length,
    score: rawScore,
  };
}

function getEntryMetaCommentMultiplier(entry: WorldBookEntryModel): number {
  const title = entry.comment || "";
  const content = entry.content || "";
  const titleTokens = tokenizeLexicalText(title);
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );

  let multiplier = 1;
  if (relationshipStyleTitle) multiplier = Math.min(multiplier, 0.18);
  if (referenceKeywordCount > 0) multiplier = Math.min(multiplier, 0.35);
  if (referenceContentSignalCount > 0) multiplier = Math.min(multiplier, 0.42);
  if (parentheticalMetaTitle) multiplier = Math.min(multiplier, 0.7);
  return multiplier;
}

function getEntrySubjectMismatchPenalty(
  entry: WorldBookEntryModel,
  queryState: VectorQueryLexicalState,
  candidateDistance: number,
): number {
  const content = entry.content || "";
  const subjectTokens = new Set<string>();

  for (const pattern of WORLD_INFO_SUBJECT_FIELD_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const fieldValue = match[1] || "";
      for (const token of tokenizeLexicalText(fieldValue)) {
        if (WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) continue;
        if (token.length < 3) continue;
        subjectTokens.add(token);
      }
    }
  }

  if (subjectTokens.size === 0) return 0;
  for (const token of subjectTokens) {
    if (queryState.tokenSet.has(token)) return 0;
  }

  const vectorWeakness = clamp01((candidateDistance - 0.9) / 0.45);
  return 0.038 + vectorWeakness * 0.024;
}

function scorePhraseMatches(
  values: string[],
  queryState: VectorQueryLexicalState,
  exactWeight: number,
  partialWeight: number,
  kind: "key" | "comment",
  maxExactMatches = 2,
): {
  exactScore: number;
  partialScore: number;
  matchedValues: string[];
  bestSpecificity: number;
  matchedSpecificity: number;
} {
  const exactSpecificities: number[] = [];
  const matchedValues: string[] = [];
  let partialScore = 0;
  let bestSpecificity = 0;
  let matchedSpecificity = 0;

  for (const value of values) {
    const rawSpecificity = getPhraseSpecificity(
      queryState.specificityState,
      value,
    );
    const specificity = getPhraseSignalStrength(rawSpecificity, value, kind);
    if (specificity <= 0) continue;

    bestSpecificity = Math.max(bestSpecificity, specificity);

    if (hasExactPhraseMatch(queryState.normalizedText, value)) {
      exactSpecificities.push(specificity);
      matchedValues.push(value);
      matchedSpecificity = Math.max(matchedSpecificity, specificity);
      continue;
    }

    const overlap = getPhraseTokenOverlap(queryState.tokenSet, value);
    if (overlap >= getPartialMatchThreshold(value, kind)) {
      matchedValues.push(value);
      matchedSpecificity = Math.max(matchedSpecificity, specificity);
      partialScore = Math.max(
        partialScore,
        overlap * specificity * partialWeight,
      );
      continue;
    }

    const rareTokenPartialScore = getRareTokenPartialScore(
      value,
      queryState,
      partialWeight,
      kind,
    );
    if (rareTokenPartialScore <= 0) continue;

    matchedValues.push(value);
    matchedSpecificity = Math.max(matchedSpecificity, specificity);
    partialScore = Math.max(partialScore, rareTokenPartialScore);
  }

  exactSpecificities.sort((a, b) => b - a);
  const exactScore = exactSpecificities
    .slice(0, maxExactMatches)
    .reduce(
      (sum, specificity, index) =>
        sum + specificity * exactWeight * (index === 0 ? 1 : 0.55),
      0,
    );

  return {
    exactScore,
    partialScore,
    matchedValues: dedupeStringsCaseInsensitive(matchedValues),
    bestSpecificity,
    matchedSpecificity,
  };
}

function buildVectorQueryLexicalState(
  queryText: string,
  specificityState: PhraseSpecificityState,
): VectorQueryLexicalState {
  return {
    normalizedText: normalizeLexicalText(queryText),
    tokenSet: new Set(tokenizeLexicalText(queryText)),
    focusTokenSet: buildFocusTokenSet(queryText, specificityState),
    specificityState,
  };
}

function getWorldInfoVectorPreset(
  mode: HybridWeightMode,
): WorldInfoVectorRankingPreset {
  return WORLD_INFO_VECTOR_PRESETS[mode] ?? WORLD_INFO_VECTOR_PRESETS.balanced;
}

function scoreVectorWorldInfoCandidate(
  entry: WorldBookEntryModel,
  candidate: embeddingsSvc.WorldBookSearchCandidate,
  queryState: VectorQueryLexicalState,
  preset: WorldInfoVectorRankingPreset,
): VectorActivatedEntry {
  const primaryMatches = scorePhraseMatches(
    entry.key || [],
    queryState,
    preset.weights.primaryExact,
    preset.weights.primaryPartial,
    "key",
  );
  const secondaryMatches = scorePhraseMatches(
    entry.keysecondary || [],
    queryState,
    preset.weights.secondaryExact,
    preset.weights.secondaryPartial,
    "key",
  );

  const comment = (entry.comment || "").trim();
  const rawCommentMatches = comment
    ? scorePhraseMatches(
        [comment],
        queryState,
        preset.weights.commentExact,
        preset.weights.commentPartial,
        "comment",
        1,
      )
    : {
        exactScore: 0,
        partialScore: 0,
        matchedValues: [],
        bestSpecificity: 0,
        matchedSpecificity: 0,
      };
  const commentMultiplier = getEntryMetaCommentMultiplier(entry);
  const commentMatches = {
    ...rawCommentMatches,
    exactScore: rawCommentMatches.exactScore * commentMultiplier,
    partialScore: rawCommentMatches.partialScore * commentMultiplier,
    bestSpecificity: rawCommentMatches.bestSpecificity * commentMultiplier,
    matchedSpecificity:
      rawCommentMatches.matchedSpecificity * commentMultiplier,
  };
  const matchedComment = rawCommentMatches.matchedValues[0] ?? null;

  const isFtsOnly = !Number.isFinite(candidate.distance);
  const vectorSimilarity = distanceToSimilarity(
    isFtsOnly ? 2 : candidate.distance,
  );
  const primaryExactScore = primaryMatches.exactScore;
  const primaryPartialScore = primaryMatches.partialScore;
  const secondaryExactScore = secondaryMatches.exactScore;
  const secondaryPartialScore = secondaryMatches.partialScore;
  const commentExactScore = commentMatches.exactScore;
  const commentPartialScore = commentMatches.partialScore;
  const focusOverlap = getEntryFocusOverlap(entry, queryState);
  const focusBoost = focusOverlap.score * 0.05;
  const priorityScore =
    clamp01((entry.priority || 0) / 100) * preset.weights.priority;
  const vectorScore = vectorSimilarity * preset.weights.vector;
  // FTS content-level match: provides a secondary vector-like signal when the entry's
  // content (not just keys) matches the query. Critical for FTS-only candidates that
  // weren't returned by vector nearest-neighbor search and have zero vectorScore.
  const lexicalContentBoost =
    candidate.lexical_score != null && candidate.lexical_score > 0
      ? clamp01(Math.log1p(candidate.lexical_score) / Math.log1p(30)) *
        preset.weights.vector *
        0.35
      : 0;
  const lexicalSpecificityAnchor = Math.max(
    primaryMatches.matchedSpecificity,
    secondaryMatches.matchedSpecificity,
    commentMatches.matchedSpecificity,
  );
  const entrySpecificityAnchor = Math.max(
    lexicalSpecificityAnchor,
    commentMatches.bestSpecificity * 0.7,
    primaryMatches.bestSpecificity * 0.45,
    secondaryMatches.bestSpecificity * 0.35,
  );
  const lexicalSignalStrength =
    primaryExactScore +
    primaryPartialScore +
    secondaryExactScore +
    secondaryPartialScore +
    commentExactScore +
    commentPartialScore;
  // Use capped distance for vectorWeakness to prevent Infinity arithmetic edge cases.
  // FTS-only candidates get weakness from distance cap (2.0), but lexicalContentBoost
  // compensates when the FTS score is strong.
  const effectiveDistance = isFtsOnly ? 2 : candidate.distance;
  const ftsWeaknessReduction =
    isFtsOnly && lexicalContentBoost > 0
      ? clamp01(lexicalContentBoost / (preset.weights.vector * 0.35)) * 0.45
      : 0;
  const vectorWeakness = clamp01(
    (effectiveDistance - 0.92) / 0.45 - ftsWeaknessReduction,
  );
  const baseBroadPenalty =
    clamp01(1 - entrySpecificityAnchor) *
    preset.weights.broadPenalty *
    (lexicalSpecificityAnchor > 0 ? 0.25 : 0.9);
  const referencePenalty =
    estimateReferenceEntryPenalty(
      entry,
      effectiveDistance,
      lexicalSpecificityAnchor,
      primaryMatches,
      secondaryMatches,
      commentMatches,
    ) *
    preset.weights.broadPenalty *
    0.95;
  const focusMissPenalty =
    focusOverlap.count === 0
      ? (0.018 + vectorWeakness * 0.028) *
        (lexicalSignalStrength > 0.02 ? 0.55 : 1) *
        (queryState.focusTokenSet.size > 0 ? 1 : 0)
      : 0;
  const subjectMismatchPenalty = getEntrySubjectMismatchPenalty(
    entry,
    queryState,
    effectiveDistance,
  );
  const broadPenalty =
    baseBroadPenalty +
    referencePenalty +
    focusMissPenalty +
    subjectMismatchPenalty;

  const finalScore = Math.max(
    0,
    vectorScore +
      lexicalContentBoost +
      primaryExactScore +
      primaryPartialScore +
      secondaryExactScore +
      secondaryPartialScore +
      commentExactScore +
      commentPartialScore +
      focusBoost +
      priorityScore -
      broadPenalty,
  );

  return {
    entry,
    score: finalScore,
    distance: candidate.distance,
    finalScore,
    lexicalCandidateScore: candidate.lexical_score,
    matchedPrimaryKeys: primaryMatches.matchedValues,
    matchedSecondaryKeys: secondaryMatches.matchedValues,
    matchedComment,
    scoreBreakdown: {
      vectorSimilarity: vectorScore,
      lexicalContentBoost,
      primaryExact: primaryExactScore,
      primaryPartial: primaryPartialScore,
      secondaryExact: secondaryExactScore,
      secondaryPartial: secondaryPartialScore,
      commentExact: commentExactScore,
      commentPartial: commentPartialScore,
      focusBoost,
      priority: priorityScore,
      broadPenalty,
      focusMissPenalty,
    },
    searchTextPreview: candidate.searchTextPreview,
  };
}

/**
 * Upper bound on the priority uplift a vector candidate can receive from its
 * finalScore. Keeps vectors competitive with equal-priority keyword entries
 * (so a good vector hit doesn't silently lose the order_value tiebreaker)
 * without letting a single strong hit override a user-chosen priority gap.
 * finalScore is typically in [0, 3]; with a 10x factor and a 20-point cap,
 * a score of ≥2.0 saturates the boost.
 */
export const VECTOR_PRIORITY_BOOST_MAX = 20;
export const VECTOR_PRIORITY_BOOST_SCALE = 10;

export function vectorPriorityBoost(finalScore: number | undefined): number {
  if (
    typeof finalScore !== "number" ||
    !Number.isFinite(finalScore) ||
    finalScore <= 0
  )
    return 0;
  const raw = Math.round(finalScore * VECTOR_PRIORITY_BOOST_SCALE);
  return Math.max(0, Math.min(VECTOR_PRIORITY_BOOST_MAX, raw));
}

/**
 * Returns a shallow-cloned array where vector-sourced entries have their
 * priority increased by a bounded, score-derived boost. Used only when the
 * entry-count budget is full so vectors can compete on their retrieval
 * score rather than losing to equal-priority keyword entries on the
 * order_value tiebreaker. Originals are never mutated.
 */
export function applyVectorPriorityBoost<
  T extends { id: string; priority: number },
>(
  entries: T[],
  sources: Map<string, { source: "keyword" | "vector"; score?: number }>,
  candidate?: { entry: { id: string }; finalScore: number },
): T[] {
  return entries.map((entry) => {
    const src =
      candidate && entry.id === candidate.entry.id
        ? { source: "vector" as const, score: candidate.finalScore }
        : sources.get(entry.id);
    if (!src || src.source !== "vector") return entry;
    const boost = vectorPriorityBoost(src.score);
    if (boost === 0) return entry;
    return { ...entry, priority: entry.priority + boost };
  });
}

/**
 * `finalizeActivatedWorldInfoEntries` receives priority-boosted clones when
 * `applyVectorPriorityBoost` was used; rebuild its `activatedEntries` from
 * the original (unboosted) entries so downstream consumers read the user's
 * configured priority, not the internal competition value.
 */
function remapFinalizedToOriginalEntries(
  finalized: FinalizedWorldInfoEntries,
  originals: WorldBookEntryModel[],
): FinalizedWorldInfoEntries {
  const byId = new Map(originals.map((e) => [e.id, e]));
  const activatedEntries = finalized.activatedEntries
    .map((e) => byId.get(e.id))
    .filter((e): e is WorldBookEntryModel => !!e);
  return { ...finalized, activatedEntries };
}

export function mergeActivatedWorldInfoEntries(
  keywordEntries: WorldBookEntryModel[],
  vectorEntries: VectorActivatedEntry[],
  settingsInput?: Partial<WorldInfoSettings>,
  bookSourceMap?: Map<string, BookSource>,
): MergedWorldInfoEntriesResult {
  const settings: WorldInfoSettings = {
    ...DEFAULT_WORLD_INFO_SETTINGS,
    ...settingsInput,
  };
  const mergedEntries: WorldBookEntryModel[] = [];
  const sources = new Map<
    string,
    { source: "keyword" | "vector"; score?: number }
  >();
  const seen = new Set<string>();
  const occupiedGroups = new Set<string>();
  const maxActivatedTarget =
    settings.maxActivatedEntries > 0
      ? settings.maxActivatedEntries
      : Number.POSITIVE_INFINITY;
  const getGroupKey = (entry: WorldBookEntryModel): string | null => {
    const groupName =
      typeof entry.group_name === "string" ? entry.group_name.trim() : "";
    return groupName ? groupName.toLowerCase() : null;
  };

  for (const entry of keywordEntries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    mergedEntries.push(entry);
    sources.set(entry.id, { source: "keyword" });
    const groupKey = getGroupKey(entry);
    if (groupKey) occupiedGroups.add(groupKey);
  }

  let finalized = finalizeActivatedWorldInfoEntries(mergedEntries, settings, {
    skipGroupLogic: true,
    preserveOrder: true,
  });

  let vectorSkippedBudget = 0;
  let vectorSkippedMinPriority = 0;
  let vectorSkippedGroup = 0;
  let vectorSkippedDedup = 0;
  let vectorSkippedBudgetSim = 0;

  for (const item of vectorEntries) {
    if (seen.has(item.entry.id)) {
      vectorSkippedDedup++;
      continue;
    }
    if (
      settings.minPriority > 0 &&
      item.entry.priority < settings.minPriority &&
      !item.entry.constant
    ) {
      vectorSkippedMinPriority++;
      continue;
    }

    const groupKey = getGroupKey(item.entry);
    if (groupKey && occupiedGroups.has(groupKey)) {
      vectorSkippedGroup++;
      continue;
    }

    // When the entry-count budget is already full from keyword entries, use
    // priority ordering so higher-priority vector entries can displace
    // lower-priority keyword entries instead of being blanket-rejected.
    const budgetFull = finalized.activatedEntries.length >= maxActivatedTarget;
    const nextMergedEntries = [...mergedEntries, item.entry];
    // When budget is full and priorities tie, order_value-ascending alone
    // decides — and vector candidates (drawn from big books with large
    // order_values) always lose. Apply a score-derived priority boost to
    // vector entries so genuinely relevant hits can displace equal-priority
    // keyword entries. The boost is bounded so it never overrides a
    // meaningful user-set priority gap. We clone the entries for the
    // finalize call and map back to originals afterwards so downstream
    // consumers still see the user's configured priority.
    const finalizeInput = budgetFull
      ? applyVectorPriorityBoost(nextMergedEntries, sources, item)
      : nextMergedEntries;
    const rawNextFinalized = finalizeActivatedWorldInfoEntries(
      finalizeInput,
      settings,
      {
        skipGroupLogic: true,
        preserveOrder: !budgetFull,
      },
    );
    const nextFinalized = budgetFull
      ? remapFinalizedToOriginalEntries(rawNextFinalized, nextMergedEntries)
      : rawNextFinalized;
    const itemSurvived = nextFinalized.activatedEntries.some(
      (entry) => entry.id === item.entry.id,
    );
    const grewActivationSet =
      nextFinalized.activatedEntries.length > finalized.activatedEntries.length;

    if (!itemSurvived) {
      if (budgetFull) vectorSkippedBudget++;
      else vectorSkippedBudgetSim++;
      continue;
    }
    // When budget has room, require growth to avoid unnecessary displacement
    // from token budget enforcement. When budget is full, displacement is
    // expected — priority ordering ensures only deserving entries win.
    if (!budgetFull && !grewActivationSet && !item.entry.constant) {
      vectorSkippedBudgetSim++;
      continue;
    }

    mergedEntries.push(item.entry);
    seen.add(item.entry.id);
    if (groupKey) occupiedGroups.add(groupKey);
    sources.set(item.entry.id, { source: "vector", score: item.finalScore });
    finalized = nextFinalized;
  }

  if (vectorEntries.length > 0) {
    const accepted =
      vectorEntries.length -
      vectorSkippedBudget -
      vectorSkippedMinPriority -
      vectorSkippedGroup -
      vectorSkippedDedup -
      vectorSkippedBudgetSim;
    console.debug(
      "[WI merge] vector candidates=%d → accepted=%d, skipped: dedup=%d, minPriority=%d, group=%d, budgetCap=%d, budgetSim=%d",
      vectorEntries.length,
      accepted,
      vectorSkippedDedup,
      vectorSkippedMinPriority,
      vectorSkippedGroup,
      vectorSkippedBudget,
      vectorSkippedBudgetSim,
    );
  }

  // Content-level deduplication: remove exact, near-exact, and fuzzy
  // duplicate content across entries from different books/sources.
  const dedupResult = deduplicateWorldInfoEntries(
    mergedEntries,
    sources,
    bookSourceMap,
  );
  for (const r of dedupResult.removed) sources.delete(r.removedEntryId);

  // Re-finalize with deduplicated set so budget is recalculated
  if (dedupResult.removed.length > 0) {
    finalized = finalizeActivatedWorldInfoEntries(
      dedupResult.entries,
      settings,
      {
        skipGroupLogic: true,
        preserveOrder: true,
      },
    );
  }

  const activatedWorldInfo: ActivatedWorldInfoEntry[] =
    finalized.activatedEntries.map((entry) => {
      const source = sources.get(entry.id);
      return {
        id: entry.id,
        comment: entry.comment || "",
        keys: entry.key || [],
        source: source?.source ?? "keyword",
        score: source?.score,
        bookId: entry.world_book_id,
        bookSource: bookSourceMap?.get(entry.world_book_id),
      };
    });

  const keywordActivated = activatedWorldInfo.filter(
    (entry) => entry.source === "keyword",
  ).length;
  const vectorActivated = activatedWorldInfo.length - keywordActivated;

  return {
    cache: finalized.cache,
    activatedEntries: finalized.activatedEntries,
    activatedWorldInfo,
    keywordActivated,
    vectorActivated,
    totalActivated: finalized.activatedEntries.length,
    estimatedTokens: finalized.estimatedTokens,
    activatedBeforeBudget: finalized.activatedBeforeBudget,
    activatedAfterBudget: finalized.activatedAfterBudget,
    evictedByBudget: finalized.evictedByBudget,
    deduplicated: dedupResult.removed.length,
    deduplicationDetails: dedupResult.removed,
  };
}

function truncateToContextSize(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function buildWorldInfoVectorQueryPreview(
  messages: Message[],
  contextSize: number,
  reasoningStrip?: SanitizeOptions,
): string {
  const queryMessages = messages
    .filter((m) => !m.extra?.hidden && m.content.trim().length > 0)
    .slice(-Math.max(1, contextSize));
  return truncateToContextSize(
    queryMessages
      .map(
        (m) =>
          `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(stripReasoningTags(m.content), reasoningStrip)}`,
      )
      .join("\n")
      .trim(),
    8000,
  );
}

export async function getWorldInfoVectorQueryPreview(
  userId: string,
  messages: Message[],
): Promise<string> {
  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  return buildWorldInfoVectorQueryPreview(
    messages,
    cfg.preferred_context_size || 3,
    getReasoningStripOptions(userId),
  );
}

function isVectorEligibleWorldInfoEntry(
  entry: import("../types/world-book").WorldBookEntry,
): boolean {
  return (
    entry.vectorized &&
    !entry.disabled &&
    (entry.content || "").trim().length > 0
  );
}

// ─── Vector WI retrieval cache (short-TTL for rapid dry-run optimization) ───

const VECTOR_WI_CACHE_TTL_MS = 30_000;
const VECTOR_WI_CACHE_MAX_ENTRIES = 128;

interface CachedVectorWiResult {
  result: VectorWorldInfoRetrievalResult;
  cachedAt: number;
}

const vectorWiCache = new Map<string, CachedVectorWiResult>();

function pruneVectorWiCache(now = Date.now()): void {
  for (const [key, cached] of vectorWiCache) {
    if (now - cached.cachedAt > VECTOR_WI_CACHE_TTL_MS) {
      vectorWiCache.delete(key);
    }
  }

  while (vectorWiCache.size >= VECTOR_WI_CACHE_MAX_ENTRIES) {
    const oldest = vectorWiCache.keys().next();
    if (oldest.done) break;
    vectorWiCache.delete(oldest.value);
  }
}

function getCachedVectorWiResult(
  cacheKey: string,
): VectorWorldInfoRetrievalResult | null {
  const cached = vectorWiCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > VECTOR_WI_CACHE_TTL_MS) {
    vectorWiCache.delete(cacheKey);
    return null;
  }
  return cached.result;
}

function setCachedVectorWiResult(
  cacheKey: string,
  result: VectorWorldInfoRetrievalResult,
): void {
  pruneVectorWiCache();
  vectorWiCache.set(cacheKey, { result, cachedAt: Date.now() });
}

export async function collectVectorActivatedWorldInfoDetailed(
  userId: string,
  chatId: string,
  worldBookIds: string[],
  entries: WorldBookEntryModel[],
  messages: Message[],
  signal?: AbortSignal,
): Promise<VectorWorldInfoRetrievalResult> {
  const emptyResult: VectorWorldInfoRetrievalResult = {
    entries: [],
    candidateTrace: [],
    queryPreview: "",
    eligibleCount: 0,
    hitsBeforeThreshold: 0,
    hitsAfterThreshold: 0,
    thresholdRejected: 0,
    hitsAfterRerankCutoff: 0,
    rerankRejected: 0,
    topK: 0,
    cap: 0,
    blockerMessages: [],
  };

  if (worldBookIds.length === 0) {
    return {
      ...emptyResult,
      blockerMessages: ["No attached world books are active for this chat."],
    };
  }

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  const worldBookVectorSettings = loadWorldBookVectorSettings(userId, {
    retrievalTopK: cfg.retrieval_top_k,
  });
  const blockerMessages: string[] = [];
  const topK = Math.max(1, worldBookVectorSettings.retrievalTopK || cfg.retrieval_top_k || 4);
  const queryText = buildWorldInfoVectorQueryPreview(
    messages,
    cfg.preferred_context_size || 3,
  );
  const eligibleEntries = entries.filter(isVectorEligibleWorldInfoEntry);

  // Check short-TTL cache for rapid dry-run reuse.
  const cacheKey = `${userId}:${chatId}:${worldBookIds.join(",")}:${eligibleEntries
    .map((e) => `${e.id}:${e.content?.length ?? 0}`)
    .join(
      ",",
    )}:${queryText}:${cfg.enabled ? 1 : 0}:${cfg.vectorize_world_books ? 1 : 0}:${cfg.dimensions ?? 0}:${topK}`;
  const cached = getCachedVectorWiResult(cacheKey);
  if (cached) {
    console.debug("[prompt-assembly] Vector WI cache hit for chat %s", chatId);
    return cached;
  }

  if (!cfg.enabled)
    blockerMessages.push(
      "Embeddings are disabled, so lorebooks will use keyword matching only.",
    );
  if (!cfg.has_api_key)
    blockerMessages.push("No embedding API key is configured.");
  if (!cfg.dimensions)
    blockerMessages.push(
      "Embeddings have not been tested yet, so dimensions are still unknown.",
    );
  if (!cfg.vectorize_world_books)
    blockerMessages.push(
      "World-book vectorization is disabled in embeddings settings.",
    );
  if (!queryText)
    blockerMessages.push(
      "The current chat does not have enough visible recent text to build a vector query.",
    );
  if (eligibleEntries.length === 0)
    blockerMessages.push(
      "This chat has no vector-enabled, non-disabled, non-empty lorebook entries to search.",
    );

  if (blockerMessages.length > 0) {
    const result = {
      ...emptyResult,
      queryPreview: queryText,
      eligibleCount: eligibleEntries.length,
      topK,
      cap: topK,
      blockerMessages,
    };
    setCachedVectorWiResult(cacheKey, result);
    return result;
  }

  try {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");

    // Attempt to reuse a previously cached query vector for this chat.
    // The cache is keyed by chat + query text hash and has a 5-minute TTL.
    let queryVector = await embeddingsSvc.getCachedQueryVector(
      chatId,
      queryText,
    );
    if (!queryVector) {
      const [vec] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText], {
        signal,
      });
      queryVector = vec;
      if (queryVector && queryVector.length > 0) {
        try {
          embeddingsSvc.cacheQueryVector(chatId, queryText, queryVector);
        } catch {
          // Non-critical cache write failure
        }
      }
    }

    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!queryVector || queryVector.length === 0) {
      const result = {
        ...emptyResult,
        queryPreview: queryText,
        eligibleCount: eligibleEntries.length,
        topK,
        cap: topK,
        blockerMessages: [
          "The embedding provider returned an empty query vector.",
        ],
      };
      setCachedVectorWiResult(cacheKey, result);
      return result;
    }

    const byId = new Map(eligibleEntries.map((entry) => [entry.id, entry]));
    const preset = getWorldInfoVectorPreset(cfg.hybrid_weight_mode);
    const fetchLimit = Math.min(
      100,
      Math.max(topK * preset.candidateMultiplier, topK),
    );
    const candidates = new Map<
      string,
      {
        entry: WorldBookEntryModel;
        candidate: embeddingsSvc.WorldBookSearchCandidate;
      }
    >();

    const searchResults = await Promise.allSettled(
      worldBookIds.map((worldBookId) =>
        embeddingsSvc.searchWorldBookEntriesHybridWithVector(
          userId,
          worldBookId,
          queryText,
          queryVector,
          fetchLimit,
          signal,
        ),
      ),
    );

    for (const result of searchResults) {
      if (result.status === "rejected") {
        console.warn("[WI] Vector search failed:", result.reason);
        continue;
      }
      for (const hit of result.value) {
        const entry = byId.get(hit.entry_id);
        if (!entry) continue;
        const existing = candidates.get(entry.id);
        if (!existing || hit.distance < existing.candidate.distance) {
          candidates.set(entry.id, { entry, candidate: hit });
        }
      }
    }

    const pooledCandidates = Array.from(candidates.values());
    const hitsBeforeThreshold = pooledCandidates.length;
    const specificityState = buildPhraseSpecificityState(eligibleEntries);
    const queryState = buildVectorQueryLexicalState(
      queryText,
      specificityState,
    );
    const scoredCandidates = pooledCandidates.map(({ entry, candidate }) =>
      scoreVectorWorldInfoCandidate(entry, candidate, queryState, preset),
    );
    // FTS-only candidates (distance = Infinity, found by full-text search but not
    // vector nearest-neighbor) bypass the distance-based similarity gate. Their quality
    // is controlled by finalScore and the rerank_cutoff instead.
    const thresholdPassed =
      cfg.similarity_threshold > 0
        ? scoredCandidates.filter((item) => {
            if (!Number.isFinite(item.distance)) return item.finalScore > 0;
            return item.distance <= cfg.similarity_threshold;
          })
        : scoredCandidates;
    const thresholdRejectedCandidates =
      cfg.similarity_threshold > 0
        ? scoredCandidates.filter((item) => {
            if (!Number.isFinite(item.distance)) return item.finalScore <= 0;
            return item.distance > cfg.similarity_threshold;
          })
        : [];
    const hitsAfterThreshold = thresholdPassed.length;
    const thresholdRejected = hitsBeforeThreshold - hitsAfterThreshold;
    thresholdPassed.sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (b.entry.priority !== a.entry.priority)
        return b.entry.priority - a.entry.priority;
      return a.entry.order_value - b.entry.order_value;
    });

    const rerankFiltered =
      cfg.rerank_cutoff > 0
        ? thresholdPassed.filter((item) => item.finalScore >= cfg.rerank_cutoff)
        : thresholdPassed;
    const rerankRejectedCandidates =
      cfg.rerank_cutoff > 0
        ? thresholdPassed.filter((item) => item.finalScore < cfg.rerank_cutoff)
        : [];
    const hitsAfterRerankCutoff = rerankFiltered.length;
    const rerankRejected = thresholdPassed.length - hitsAfterRerankCutoff;

    const cap = topK;
    const shortlistedEntries = rerankFiltered.slice(0, cap);
    const topKTrimmedEntries = rerankFiltered.slice(cap);
    const rerankRankById = new Map<string, number>(
      thresholdPassed.map((item, index) => [item.entry.id, index + 1]),
    );
    const candidateTrace: VectorRetrievalTraceEntry[] = [
      ...shortlistedEntries.map((item) => ({
        ...item,
        retrievalStage: "shortlisted" as const,
        rerankRank: rerankRankById.get(item.entry.id) ?? null,
      })),
      ...topKTrimmedEntries.map((item) => ({
        ...item,
        retrievalStage: "trimmed_by_top_k" as const,
        rerankRank: rerankRankById.get(item.entry.id) ?? null,
      })),
      ...rerankRejectedCandidates.map((item) => ({
        ...item,
        retrievalStage: "rejected_by_rerank_cutoff" as const,
        rerankRank: rerankRankById.get(item.entry.id) ?? null,
      })),
      ...thresholdRejectedCandidates
        .sort((a, b) => a.distance - b.distance)
        .map((item) => ({
          ...item,
          retrievalStage: "rejected_by_similarity_threshold" as const,
          rerankRank: null,
        })),
    ];

    const result = {
      entries: shortlistedEntries,
      candidateTrace,
      queryPreview: queryText,
      eligibleCount: eligibleEntries.length,
      hitsBeforeThreshold,
      hitsAfterThreshold,
      thresholdRejected,
      hitsAfterRerankCutoff,
      rerankRejected,
      topK,
      cap,
      blockerMessages,
    };
    setCachedVectorWiResult(cacheKey, result);
    return result;
  } catch (err) {
    // Caller-initiated abort bubbles up so the whole pipeline can unwind
    // instead of silently returning an empty result and continuing.
    if (signal?.aborted || (err as any)?.name === "AbortError") throw err;
    console.warn("[prompt] Vector activated world info retrieval failed:", err);
    return {
      ...emptyResult,
      queryPreview: queryText,
      eligibleCount: eligibleEntries.length,
      topK,
      cap: topK,
      blockerMessages: [
        err instanceof Error
          ? err.message
          : "Vector activated world info retrieval failed.",
      ],
    };
  }
}

export async function collectVectorActivatedWorldInfo(
  userId: string,
  chatId: string,
  worldBookIds: string[],
  entries: import("../types/world-book").WorldBookEntry[],
  messages: Message[],
  signal?: AbortSignal,
): Promise<VectorActivatedEntry[]> {
  const result = await collectVectorActivatedWorldInfoDetailed(
    userId,
    chatId,
    worldBookIds,
    entries,
    messages,
    signal,
  );
  return result.entries;
}

/**
 * Get all activated world info entries for a chat (keyword + vector).
 * Standalone helper for the Spindle RPC bridge — runs WI activation
 * without the full prompt assembly pipeline.
 */
export async function getActivatedWorldInfoForChat(
  userId: string,
  chatId: string,
): Promise<ActivatedWorldInfoEntry[]> {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");

  const messages = chatsSvc.getMessages(userId, chatId);
  const character = charactersSvc.getCharacter(userId, chat.character_id);
  if (!character) throw new Error("Character not found");

  const persona = personasSvc.resolvePersonaOrDefault(userId);

  const globalWorldBookIds =
    (settingsSvc.getSetting(userId, "globalWorldBooks")?.value as
      | string[]
      | undefined) ?? [];
  const chatWorldBookIds =
    (chat.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
  const wiSources = collectWorldInfoSources(
    userId,
    character,
    persona,
    globalWorldBookIds,
    chatWorldBookIds,
  );
  const wiState: WiState = (chat.metadata?.wi_state as WiState) ?? {};
  const worldInfoSettings =
    (settingsSvc.getSetting(userId, "worldInfoSettings")?.value as
      | Partial<WorldInfoSettings>
      | undefined) ?? {};

  const wiResult = activateWorldInfo({
    entries: wiSources.entries,
    messages,
    chatTurn: messages.length,
    wiState,
    settings: worldInfoSettings,
  });

  const vectorActivated = await collectVectorActivatedWorldInfo(
    userId,
    chatId,
    wiSources.worldBookIds,
    wiSources.entries,
    messages,
  );
  return mergeActivatedWorldInfoEntries(
    wiResult.activatedEntries,
    vectorActivated,
    worldInfoSettings,
    wiSources.bookSourceMap,
  ).activatedWorldInfo;
}

/**
 * Retrieve relevant memories from vectorized chat history for long-term context.
 *
 * What i went with:
 * 1. Take the most recent N messages as a query (based on preferred_context_size)
 * 2. Checks for cached query vector first (fast path)
 * 3. If chunks aren't vectorized yet, falls back to SQLite recency-based retrieval
 * 4. Excludes recent messages (within exclusionWindow) to avoid redundancy
 * 5. Returns the most semantically relevant past memories
 */

export interface MemoryRetrievalResult {
  chunks: Array<{ content: string; score: number; metadata: any }>;
  formatted: string;
  count: number;
  enabled: boolean;
  queryPreview: string;
  settingsSource: "global" | "per_chat";
  chunksAvailable: number;
  chunksPending: number;
}

function buildQueryText(
  messages: Message[],
  settings: import("./embeddings.service").ChatMemorySettings,
  reasoningStrip?: SanitizeOptions,
): string {
  const visibleMessages = messages.filter(
    (m) => !m.extra?.hidden && m.content.trim().length > 0,
  );
  const contextSize = Math.max(1, settings.queryContextSize);

  switch (settings.queryStrategy) {
    case "last_user_message": {
      const lastUser = [...visibleMessages].reverse().find((m) => m.is_user);
      if (!lastUser) return "";
      return truncateToContextSize(
        `[USER | ${lastUser.name}]: ${sanitizeForVectorization(lastUser.content, reasoningStrip)}`,
        settings.queryMaxTokens,
      );
    }
    case "weighted_recent": {
      const queryMessages = visibleMessages.slice(-contextSize);
      const parts = queryMessages.map(
        (m) =>
          `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(m.content, reasoningStrip)}`,
      );
      // Repeat last message for recency bias
      if (parts.length > 0) parts.push(parts[parts.length - 1]);
      return truncateToContextSize(
        parts.join("\n").trim(),
        settings.queryMaxTokens,
      );
    }
    case "recent_messages":
    default: {
      const queryMessages = visibleMessages.slice(-contextSize);
      return truncateToContextSize(
        queryMessages
          .map(
            (m) =>
              `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(m.content, reasoningStrip)}`,
          )
          .join("\n")
          .trim(),
        settings.queryMaxTokens,
      );
    }
  }
}

function formatMemoryOutput(
  chunks: Array<{ content: string; score: number; metadata: any }>,
  settings: import("./embeddings.service").ChatMemorySettings,
): string {
  if (chunks.length === 0) return "";

  const renderedChunks = chunks.map((c) => {
    let rendered = settings.chunkTemplate;
    rendered = rendered.replace(/\{\{content\}\}/g, c.content);
    rendered = rendered.replace(/\{\{score\}\}/g, c.score.toFixed(4));
    const meta = c.metadata ?? {};
    rendered = rendered.replace(
      /\{\{startIndex\}\}/g,
      String(meta.startIndex ?? "?"),
    );
    rendered = rendered.replace(
      /\{\{endIndex\}\}/g,
      String(meta.endIndex ?? "?"),
    );
    return rendered;
  });

  const joined = renderedChunks.join(settings.chunkSeparator);
  return settings.memoryHeaderTemplate.replace(/\{\{memories\}\}/g, joined);
}

/**
 * Format a CortexResult into a MemoryRetrievalResult and populate the macro
 * environment. Used by both the warm-cache and await-cortex branches.
 */
function formatCortexForAssembly(
  cortexResult: memoryCortex.CortexResult,
  cortexConfig: memoryCortex.MemoryCortexConfig,
  character: Character | null,
  macroEnv: MacroEnv,
  chatId: string,
): Awaited<ReturnType<typeof collectChatVectorMemory>> {
  const shadowResult = memoryCortex.formatShadowPrompt(
    cortexResult.memories,
    cortexResult.entityContext,
    cortexResult.activeRelationships,
    cortexResult.arcContext,
    {
      mode: cortexConfig.formatterMode as any,
      tokenBudget: cortexConfig.contextTokenBudget,
      currentSpeakerName: character?.name,
    },
  );

  const colorMapText = memoryCortex.formatColorMapForPrompt(chatId);
  macroEnv.extra.cortex = {
    memories: cortexResult.memories,
    entityContext: cortexResult.entityContext,
    activeRelationships: cortexResult.activeRelationships,
    arcContext: cortexResult.arcContext,
    formatted: colorMapText
      ? shadowResult.text + "\n\n" + colorMapText
      : shadowResult.text,
    colorMap: colorMapText,
  };

  return {
    chunks: cortexResult.memories.map((m) => ({
      content: m.content,
      score: m.finalScore,
      metadata: { components: m.components, entityNames: m.entityNames },
    })),
    formatted: shadowResult.text,
    count: cortexResult.memories.length,
    enabled: true,
    queryPreview: "",
    settingsSource: "global" as const,
    chunksAvailable: 0,
    chunksPending: 0,
  };
}

/** Fault-tolerant wrapper: embedding timeouts or failures should never kill generation. */
async function safeCollectChatVectorMemory(
  ...args: Parameters<typeof collectChatVectorMemory>
): Promise<Awaited<ReturnType<typeof collectChatVectorMemory>>> {
  try {
    return await collectChatVectorMemory(...args);
  } catch (err) {
    console.warn(
      "[prompt-assembly] Chat vector memory retrieval failed, continuing without memories:",
      err,
    );
    return {
      chunks: [],
      formatted: "",
      count: 0,
      enabled: false,
      queryPreview: "",
      settingsSource: "global",
      chunksAvailable: 0,
      chunksPending: 0,
    };
  }
}

export async function collectChatVectorMemory(
  userId: string,
  chatId: string,
  messages: Message[],
  chatMemorySettings?: import("./embeddings.service").ChatMemorySettings | null,
  perChatOverrides?:
    | import("./embeddings.service").PerChatMemoryOverrides
    | null,
  _excludeMessageId?: string,
): Promise<MemoryRetrievalResult> {
  const result = await readCachedChatMemory(
    userId,
    chatId,
    messages,
    chatMemorySettings ?? null,
    perChatOverrides ?? null,
  );

  if (_excludeMessageId && result.chunks.length > 0) {
    const filteredChunks = result.chunks.filter((chunk) => {
      const messageIds = Array.isArray(chunk.metadata?.messageIds)
        ? (chunk.metadata.messageIds as string[])
        : null;
      return !(messageIds && messageIds.includes(_excludeMessageId));
    });

    if (filteredChunks.length !== result.chunks.length) {
      const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
      const settings = embeddingsSvc.resolveEffectiveChatMemorySettings(
        chatMemorySettings ?? null,
        cfg,
      );
      return {
        chunks: filteredChunks,
        formatted: formatMemoryOutput(filteredChunks, settings),
        count: filteredChunks.length,
        enabled: result.enabled,
        queryPreview: result.queryPreview,
        settingsSource: result.settingsSource,
        chunksAvailable: result.chunksAvailable,
        chunksPending: result.chunksPending,
      };
    }
  }

  return {
    chunks: result.chunks,
    formatted: result.formatted,
    count: result.count,
    enabled: result.enabled,
    queryPreview: result.queryPreview,
    settingsSource: result.settingsSource,
    chunksAvailable: result.chunksAvailable,
    chunksPending: result.chunksPending,
  };
}

function injectWorldInfoAt(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  entries: Array<{
    content: string;
    role: "system" | "user" | "assistant";
    entryLabel: string;
  }>,
  insertAt: number,
  name: string,
): number {
  if (entries.length === 0) return 0;
  let idx = Math.max(0, Math.min(insertAt, result.length));
  for (const entry of entries) {
    result.splice(idx, 0, { role: entry.role, content: entry.content });
    breakdown.push({
      type: "world_info",
      name: formatWorldInfoBreakdownName(name, entry.entryLabel),
      role: entry.role,
      content: entry.content,
    });
    idx++;
  }
  return entries.length;
}

function formatWorldInfoBreakdownName(
  positionLabel: string,
  entryLabel: string,
): string {
  return `${positionLabel}: ${entryLabel}`;
}

function pruneEmptyWorldInfoEntriesInPlace<T extends { content: string }>(
  entries: T[],
): void {
  const filtered = entries.filter((entry) => entry.content.trim().length > 0);
  if (filtered.length === entries.length) return;
  entries.length = 0;
  entries.push(...filtered);
}

function pruneEmptyWorldInfoCacheEntries(cache: WorldInfoCache): void {
  pruneEmptyWorldInfoEntriesInPlace(cache.before);
  pruneEmptyWorldInfoEntriesInPlace(cache.after);
  pruneEmptyWorldInfoEntriesInPlace(cache.anBefore);
  pruneEmptyWorldInfoEntriesInPlace(cache.anAfter);
  pruneEmptyWorldInfoEntriesInPlace(cache.depth);
  pruneEmptyWorldInfoEntriesInPlace(cache.emBefore);
  pruneEmptyWorldInfoEntriesInPlace(cache.emAfter);
}

function injectPromptBlocksAt(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  entries: Array<{ content: string; role: LlmMessage["role"]; name: string }>,
  insertAt: number,
): number {
  if (entries.length === 0) return 0;
  let idx = Math.max(0, Math.min(insertAt, result.length));
  for (const entry of entries) {
    result.splice(idx, 0, { role: entry.role, content: entry.content });
    breakdown.push({
      type: "block",
      name: entry.name,
      role: entry.role,
      content: entry.content,
    });
    idx++;
  }
  return entries.length;
}

/**
 * Apply a group of appends that share the same target (baseRole + depth)
 * in a single pass. Contents are concatenated in prompt_order sequence
 * with no extra separator — each rawResolved already carries whatever
 * whitespace the user placed around it.
 */
function applyAppendGroup(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  group: PendingAppend[],
): void {
  if (group.length === 0) return;
  const { baseRole, depth } = group[0];

  // Join all raw contents in order — the first gets a "\n" separator from the
  // base message, subsequent appends are separated from each other directly
  // so user-controlled whitespace (leading/trailing newlines) is the only
  // thing between them.
  const combinedContent = group.map((a) => a.content).join("");

  let roleCount = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === baseRole && isChatHistoryMessage(result[i])) {
      if (roleCount === depth) {
        if (typeof result[i].content === "string") {
          result[i] = {
            ...result[i],
            content: result[i].content + "\n" + combinedContent,
          };
        } else {
          // Multipart: append to the text part
          const parts = [
            ...(result[i].content as import("../llm/types").LlmMessagePart[]),
          ];
          const textIdx = parts.findIndex((p) => p.type === "text");
          if (textIdx >= 0) {
            const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
            parts[textIdx] = {
              type: "text",
              text: tp.text + "\n" + combinedContent,
            };
          } else {
            parts.unshift({ type: "text", text: combinedContent });
          }
          result[i] = { ...result[i], content: parts };
        }
        for (const append of group) {
          breakdown.push({
            type: "append",
            name: `${append.blockName} → ${baseRole}@${depth}`,
            role: baseRole,
            content: append.content,
            blockId: append.blockId,
          });
        }
        return;
      }
      roleCount++;
    }
  }
  // Target not found — skip silently
}

/**
 * Merge consecutive user messages in the chat history range into single messages,
 * joining their text content with double newlines. This collapses "queued" user
 * messages into one LLM turn so providers that disallow consecutive same-role
 * messages don't reject the request.
 *
 * Mutates `result` in-place and returns the new history count (may be smaller
 * than the original if merges occurred).
 */
function mergeConsecutiveUserMessages(
  result: LlmMessage[],
  startIdx: number,
  count: number,
): number {
  let remaining = count;
  let i = startIdx;
  while (i < startIdx + remaining - 1) {
    if (result[i].role === "user" && result[i + 1]?.role === "user") {
      const a = result[i].content;
      const b = result[i + 1].content;

      // Extract text from each message (string or multipart)
      const aText =
        typeof a === "string"
          ? a
          : a
              .filter(
                (p): p is import("../llm/types").LlmTextPart =>
                  p.type === "text",
              )
              .map((p) => p.text)
              .join("");
      const bText =
        typeof b === "string"
          ? b
          : b
              .filter(
                (p): p is import("../llm/types").LlmTextPart =>
                  p.type === "text",
              )
              .map((p) => p.text)
              .join("");
      const mergedText = aText + "\n\n" + bText;

      // Collect non-text parts (images, audio) from both messages
      const aParts =
        typeof a === "string" ? [] : a.filter((p) => p.type !== "text");
      const bParts =
        typeof b === "string" ? [] : b.filter((p) => p.type !== "text");
      const allParts = [...aParts, ...bParts];

      // Preserve the chat-history marker if either source message carried it
      // — both are typically chat-history user turns being merged.
      const wasChatHistory =
        isChatHistoryMessage(result[i]) || isChatHistoryMessage(result[i + 1]);
      if (allParts.length > 0) {
        result[i] = {
          role: "user",
          content: [{ type: "text" as const, text: mergedText }, ...allParts],
        };
      } else {
        result[i] = { role: "user", content: mergedText };
      }
      if (wasChatHistory) markAsChatHistory(result[i]);
      result.splice(i + 1, 1);
      remaining--;
      // Don't increment — next element slid into i+1, check again
    } else {
      i++;
    }
  }
  return remaining;
}

/**
 * Strip reasoning tags (and surrounding whitespace) from older assistant messages
 * in the chat history range based on reasoningSettings.keepInHistory.
 *
 *   keepInHistory = -1  → keep all (no-op)
 *   keepInHistory =  0  → strip reasoning from every message
 *   keepInHistory =  N  → keep only the N most recent reasoning blocks
 */
function stripReasoningFromChatHistory(
  result: LlmMessage[],
  firstChatIdx: number,
  historyCount: number,
  reasoningSettings: {
    prefix?: string;
    suffix?: string;
    keepInHistory?: number;
  },
): void {
  const keepInHistory = reasoningSettings.keepInHistory ?? -1;
  if (keepInHistory === -1) return;

  const delimiters = resolveReasoningDelimiters(reasoningSettings);
  if (!hasReasoningDelimiters(delimiters)) return;

  const escapedPrefix = delimiters.prefix.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const escapedSuffix = delimiters.suffix.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const pattern = new RegExp(
    `\\s*${escapedPrefix}[\\s\\S]*?${escapedSuffix}\\s*`,
    "g",
  );

  const endIdx = firstChatIdx + historyCount;
  let reasoningBlocksSeen = 0;

  for (let i = endIdx - 1; i >= firstChatIdx; i--) {
    if (result[i].role !== "assistant") continue;
    const content = result[i].content;
    if (typeof content !== "string") continue;

    const stripped = content.replace(pattern, "").trim();
    if (stripped === content.trim()) continue; // No reasoning found

    reasoningBlocksSeen++;
    if (reasoningBlocksSeen > keepInHistory) {
      result[i] = { ...result[i], content: stripped };
    }
  }
}

// ---------------------------------------------------------------------------
// Context Filters — strip or keep-only details blocks, loom tags, HTML tags
// ---------------------------------------------------------------------------

interface ContextFilterConfig {
  enabled: boolean;
  keepDepth: number;
  /** When true, past keepDepth: keep ONLY matching content, strip everything else */
  keepOnly?: boolean;
}

interface ContextFilterHtmlConfig extends ContextFilterConfig {
  stripFonts?: boolean;
  fontKeepDepth?: number;
}

interface ContextFilters {
  htmlTags?: ContextFilterHtmlConfig;
  detailsBlocks?: ContextFilterConfig;
  loomItems?: ContextFilterConfig;
}

// Loom-related tags to match
const LOOM_TAGS = [
  "loom_sum",
  "loom_if",
  "loom_else",
  "loom_endif",
  "lumia_ooc",
  "lumiaooc",
  "lumio_ooc",
  "lumioooc",
  "loom_state",
  "loom_memory",
  "loom_context",
  "loom_inject",
  "loom_var",
  "loom_set",
  "loom_get",
  "loom_record",
  "loomrecord",
  "loom_ledger",
  "loomledger",
];

// Pre-compiled regexes for loom tags (paired + self-closing)
const LOOM_TAG_REGEXES = LOOM_TAGS.map((tag) => ({
  paired: new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"),
  self: new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>`, "gi"),
}));

// HTML formatting tags to strip (preserves inner text)
const HTML_FORMAT_TAGS = [
  "span",
  "b",
  "i",
  "u",
  "em",
  "strong",
  "s",
  "strike",
  "sub",
  "sup",
  "mark",
  "small",
  "big",
];
const HTML_TAG_REGEXES = HTML_FORMAT_TAGS.map((tag) => ({
  open: new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"),
  close: new RegExp(`</${tag}>`, "gi"),
}));

const MAX_FILTER_ITERATIONS = 20;

// Use shared implementations from content-sanitizer.ts
const stripDetailsBlocks = _stripDetailsBlocks;
const stripLoomTags = _stripLoomTags;
const stripHtmlFormattingTags = _stripHtmlFormattingTags;
const collapseExcessiveNewlines = _collapseExcessiveNewlines;

/** Extract only the inner text of <details>...</details> blocks, discard everything else. */
function keepOnlyDetailsBlocks(content: string): string {
  const parts: string[] = [];
  const pattern = /<details(?:\s[^>]*)?>([\s\S]*?)<\/details>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const inner = match[1].trim();
    if (inner) parts.push(inner);
  }
  return parts.join("\n\n");
}

/** Extract only the inner text of loom-related tags, discard everything else. */
function keepOnlyLoomTags(content: string): string {
  const parts: string[] = [];
  for (const { paired } of LOOM_TAG_REGEXES) {
    paired.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = paired.exec(content)) !== null) {
      const inner = match[1].trim();
      if (inner) parts.push(inner);
    }
  }
  return parts.join("\n\n");
}

/** Strip <font> tags (preserving inner text). */
function stripFontTags(content: string): string {
  return content.replace(/<font(?:\s[^>]*)?>/gi, "").replace(/<\/font>/gi, "");
}

/**
 * Apply context filters to chat history messages.
 * For each filter, messages within keepDepth of the end are untouched.
 * Older messages have the matching content stripped (normal mode) or
 * everything EXCEPT the matching content stripped (keepOnly mode).
 */
function applyContextFilters(
  result: LlmMessage[],
  firstChatIdx: number,
  historyCount: number,
  filters: ContextFilters,
): void {
  const html = filters.htmlTags;
  const details = filters.detailsBlocks;
  const loom = filters.loomItems;

  const htmlEnabled = html?.enabled ?? false;
  const fontEnabled = html?.stripFonts ?? false;
  const detailsEnabled = details?.enabled ?? false;
  const loomEnabled = loom?.enabled ?? false;

  if (!htmlEnabled && !detailsEnabled && !loomEnabled) return;

  const htmlKeepDepth = html?.keepDepth ?? 3;
  const fontKeepDepth = html?.fontKeepDepth ?? 3;
  const detailsKeepDepth = details?.keepDepth ?? 3;
  const loomKeepDepth = loom?.keepDepth ?? 5;

  const detailsKeepOnly = details?.keepOnly ?? false;
  const loomKeepOnly = loom?.keepOnly ?? false;

  const endIdx = firstChatIdx + historyCount;

  for (let i = firstChatIdx; i < endIdx; i++) {
    const content = result[i].content;
    if (typeof content !== "string") continue;

    const depthFromEnd = endIdx - 1 - i;
    let filtered = content;

    const applyDetails = detailsEnabled && depthFromEnd >= detailsKeepDepth;
    const applyLoom = loomEnabled && depthFromEnd >= loomKeepDepth;
    const applyHtml = htmlEnabled && depthFromEnd >= htmlKeepDepth;
    const applyFonts =
      htmlEnabled && fontEnabled && depthFromEnd >= fontKeepDepth;

    // Phase 1: keepOnly extractions from ORIGINAL content, unioned if both active.
    // This must run before HTML stripping so inner HTML is still intact for matching.
    const hasKeepOnly =
      (applyDetails && detailsKeepOnly) || (applyLoom && loomKeepOnly);

    if (hasKeepOnly) {
      const parts: string[] = [];
      if (applyDetails && detailsKeepOnly) {
        const extracted = keepOnlyDetailsBlocks(content);
        if (extracted) parts.push(extracted);
      }
      if (applyLoom && loomKeepOnly) {
        const extracted = keepOnlyLoomTags(content);
        if (extracted) parts.push(extracted);
      }
      filtered = parts.join("\n\n");
    }

    // Phase 2: strip modes (applied to extracted content or original)
    if (applyDetails && !detailsKeepOnly) {
      filtered = stripDetailsBlocks(filtered);
    }
    if (applyLoom && !loomKeepOnly) {
      filtered = stripLoomTags(filtered);
    }

    // Phase 3: HTML tag stripping AFTER content extraction, so it cleans kept content too
    if (applyHtml) {
      filtered = stripHtmlFormattingTags(filtered);
    }
    if (applyFonts) {
      filtered = stripFontTags(filtered);
    }

    // Clean up excessive newlines left by removals
    if (filtered !== content) {
      filtered = collapseExcessiveNewlines(filtered).trim();
      result[i] = { ...result[i], content: filtered };
    }
  }
}

/**
 * Apply CompletionSettings as a post-processing pass on the assembled messages.
 * Handles squashSystemMessages, useSystemPrompt, and namesBehavior
 * in a single O(n) pass using write-pointer compaction for system message
 * squashing (avoids O(n²) splice-in-loop).
 */
function applyCompletionSettings(
  result: LlmMessage[],
  settings: CompletionSettings,
  character: Character,
  persona: Persona | null,
  generationType: GenerationType,
): void {
  const squash = settings.squashSystemMessages;
  const noSystem = settings.useSystemPrompt === false;
  const namesBehavior = settings.namesBehavior ?? 0;

  // When squashing, use write-pointer compaction to avoid O(n²) splices.
  // Read pointer advances through every message; write pointer only advances
  // when we emit a message. Consecutive system messages are merged into the
  // write-pointer's current position.
  let write = 0;
  for (let read = 0; read < result.length; read++) {
    let msg = result[read];

    // Squash: merge consecutive system messages into the previous written message
    // If noSystem is true, the previous system message was already converted to "user",
    // so we must check if it was originally a system message. We can tag it to know.
    const isSystem = msg.role === "system";

    if (
      squash &&
      isSystem &&
      write > 0 &&
      (result[write - 1] as any)._fromSystem
    ) {
      const prev = result[write - 1];
      let newContent = "";
      if (typeof prev.content === "string") {
        newContent =
          prev.content +
          "\n\n" +
          (typeof msg.content === "string" ? msg.content : "");
      } else {
        // Fallback if it was an array for some reason
        const prevText =
          prev.content.find((p) => p.type === "text")?.text || "";
        newContent =
          prevText +
          "\n\n" +
          (typeof msg.content === "string" ? msg.content : "");
      }
      result[write - 1] = { ...prev, content: newContent };
      continue; // don't advance write pointer
    }

    // useSystemPrompt false: convert system → user
    if (noSystem && isSystem) {
      msg = { ...msg, role: "user" };
    }

    // Tag the message if it originated as a system message so squash can find it
    if (isSystem) {
      (msg as any)._fromSystem = true;
    }

    // namesBehavior: 1 = add name field, 2 = prepend "Name: " to content
    if (
      namesBehavior === 1 &&
      (msg.role === "user" || msg.role === "assistant")
    ) {
      const name =
        msg.role === "user"
          ? (persona?.name ?? "User")
          : getEffectiveCharacterName(character);
      msg = { ...msg, name };
    } else if (
      namesBehavior === 2 &&
      (msg.role === "user" || msg.role === "assistant")
    ) {
      const name =
        msg.role === "user"
          ? (persona?.name ?? "User")
          : getEffectiveCharacterName(character);
      if (typeof msg.content === "string") {
        msg = { ...msg, content: `${name}: ${msg.content}` };
      } else {
        const parts = [
          ...(msg.content as import("../llm/types").LlmMessagePart[]),
        ];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
          parts[textIdx] = { type: "text", text: `${name}: ${tp.text}` };
        }
        msg = { ...msg, content: parts };
      }
    }

    if (write !== read) result[write] = msg;
    else if (msg !== result[read]) result[write] = msg;
    write++;
  }

  // Truncate the array to the compacted length
  if (write < result.length) {
    result.length = write;
  }
}

/**
 * Collapse all assembled messages into a single `user` message.
 *
 * Concatenates text content from every message with double-newline separators.
 * Media parts (images/audio) are collected into a single multipart message.
 * Best used alongside `namesBehavior: 2` ("In Content") so user/assistant turns
 * are visually separated by name prefixes within the collapsed text.
 *
 * Mutates the `result` array in place.
 */
function collapseToSingleUserMessage(result: LlmMessage[]): void {
  if (result.length <= 1) return;

  const textChunks: string[] = [];
  const mediaParts: import("../llm/types").LlmMessagePart[] = [];

  for (const msg of result) {
    if (typeof msg.content === "string") {
      if (msg.content) textChunks.push(msg.content);
    } else {
      // Multipart: collect text and media separately
      for (const part of msg.content) {
        if (part.type === "text") {
          if (part.text) textChunks.push(part.text);
        } else {
          mediaParts.push(part);
        }
      }
    }
  }

  const collapsed = textChunks.join("\n\n");

  // Replace entire array with a single user message
  result.length = 0;
  if (mediaParts.length > 0) {
    // Multipart: text first, then media
    const parts: import("../llm/types").LlmMessagePart[] = [
      { type: "text", text: collapsed },
      ...mediaParts,
    ];
    result.push({ role: "user", content: parts });
  } else {
    result.push({ role: "user", content: collapsed });
  }
}

// ---------------------------------------------------------------------------
// Context budget clipping
// ---------------------------------------------------------------------------

/**
 * Minimum safety margin in tokens. Even on tiny context windows we want some
 * headroom for later mutations (council deliberation splice, interceptor
 * parameter injection, tokenizer variance between our count and provider count).
 */
const MIN_CLIP_SAFETY_MARGIN = 256;
/** Safety margin as a fraction of `contextSize`. `max(MIN, ratio * contextSize)` wins. */
const CLIP_SAFETY_MARGIN_RATIO = 0.02;
/** Fallback response headroom when `max_tokens` is unset. Matches the industry default. */
const FALLBACK_MAX_RESPONSE_TOKENS = 4096;

/**
 * Clip oldest chat-history messages from the assembled prompt so the total
 * fits within the preset's `contextSize` (minus response headroom + margin).
 *
 * Single-pass tokenization: each message is counted exactly once. Chat-history
 * messages are identified by the `__chatHistorySource` marker (survives all
 * spread-based mutations). Newest→oldest walk picks keepers until the budget
 * is hit; the remaining oldest are dropped via a single `filter()`.
 *
 * Mutates `result` in place when clipping occurs. Returns stats so the caller
 * can emit them on `GENERATION_STARTED` / dry-run so the UI can surface a
 * "N messages hidden" indicator.
 */
export async function clipToContextBudget(
  result: LlmMessage[],
  modelId: string | null,
  maxContext: number | null | undefined,
  maxResponseTokens: number | null | undefined,
  signal?: AbortSignal,
): Promise<ContextClipStats> {
  const resolvedContext =
    typeof maxContext === "number" && maxContext > 0 ? maxContext : 0;
  const resolvedResponse =
    typeof maxResponseTokens === "number" && maxResponseTokens > 0
      ? maxResponseTokens
      : FALLBACK_MAX_RESPONSE_TOKENS;

  if (resolvedContext <= 0) {
    return {
      enabled: false,
      maxContext: 0,
      maxResponseTokens: resolvedResponse,
      safetyMargin: 0,
      inputBudget: 0,
      fixedTokens: 0,
      remainingHistoryBudget: 0,
      chatHistoryTokensBefore: 0,
      chatHistoryTokensAfter: 0,
      messagesDropped: 0,
      tokensDropped: 0,
      tokenizerUsed: APPROXIMATE_TOKENIZER_NAME,
    };
  }

  const safetyMargin = Math.max(
    MIN_CLIP_SAFETY_MARGIN,
    Math.floor(resolvedContext * CLIP_SAFETY_MARGIN_RATIO),
  );
  const inputBudget = resolvedContext - resolvedResponse - safetyMargin;

  const counter = await resolveCounter(modelId || "");

  const n = result.length;
  const tokens: number[] = new Array(n);
  const historyIndices: number[] = [];
  let fixedTokens = 0;
  let chatHistoryTokensBefore = 0;
  for (let i = 0; i < n; i++) {
    // Cooperative yield every 64 messages so a stop clicked during tokenization
    // of a long chat can land before we finish. `counter.count()` is sync and
    // can be ~0.5ms/message on Termux; a 2000-message chat would otherwise
    // block the event loop for a full second.
    if (i > 0 && (i & 63) === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (signal?.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const msg = result[i];
    const text = `${msg.role}\n${getTextContent(msg)}`;
    const t = counter.count(text);
    tokens[i] = t;
    if (isChatHistoryMessage(msg)) {
      historyIndices.push(i);
      chatHistoryTokensBefore += t;
    } else {
      fixedTokens += t;
    }
  }

  const remainingHistoryBudget = inputBudget - fixedTokens;

  const makeStats = (
    overrides: Partial<ContextClipStats>,
  ): ContextClipStats => ({
    enabled: true,
    maxContext: resolvedContext,
    maxResponseTokens: resolvedResponse,
    safetyMargin,
    inputBudget,
    fixedTokens,
    remainingHistoryBudget,
    chatHistoryTokensBefore,
    chatHistoryTokensAfter: chatHistoryTokensBefore,
    messagesDropped: 0,
    tokensDropped: 0,
    tokenizerUsed: counter.name,
    ...overrides,
  });

  // Misconfigured budget (e.g. maxContext smaller than max_tokens + margin).
  // Don't clip silently — surface the misconfiguration via `budgetInvalid`.
  if (inputBudget <= 0) {
    return makeStats({ budgetInvalid: true });
  }

  if (remainingHistoryBudget <= 0) {
    let write = 0;
    for (let read = 0; read < n; read++) {
      const msg = result[read];
      if (isChatHistoryMessage(msg)) continue;
      if (write !== read) result[write] = msg;
      write++;
    }
    result.length = write;

    return makeStats({
      chatHistoryTokensAfter: 0,
      messagesDropped: historyIndices.length,
      tokensDropped: chatHistoryTokensBefore,
      fixedOverBudget: remainingHistoryBudget < 0,
    });
  }

  // Walk history newest→oldest; remember the oldest index we can keep.
  const remainingBudget = remainingHistoryBudget;
  let accHistoryTokens = 0;
  let oldestKeptHistoryIdx = -1;
  if (remainingBudget > 0) {
    for (let i = historyIndices.length - 1; i >= 0; i--) {
      const t = tokens[historyIndices[i]];
      if (accHistoryTokens + t > remainingBudget) break;
      accHistoryTokens += t;
      oldestKeptHistoryIdx = i;
    }
  }

  if (oldestKeptHistoryIdx === 0 || historyIndices.length === 0) {
    return makeStats({});
  }

  const droppedCount =
    oldestKeptHistoryIdx === -1 ? historyIndices.length : oldestKeptHistoryIdx;
  let tokensDropped = 0;
  for (let i = 0; i < droppedCount; i++) {
    tokensDropped += tokens[historyIndices[i]];
  }

  // historyIndices is monotonically increasing, so messages with raw index
  // below `firstKeptRawIdx` are exactly the dropped history messages. Using
  // a boundary comparison avoids allocating a Set per generation.
  const firstKeptRawIdx =
    oldestKeptHistoryIdx === -1
      ? Number.POSITIVE_INFINITY
      : historyIndices[oldestKeptHistoryIdx];
  let write = 0;
  for (let read = 0; read < n; read++) {
    const msg = result[read];
    if (isChatHistoryMessage(msg) && read < firstKeptRawIdx) continue;
    if (write !== read) result[write] = msg;
    write++;
  }
  result.length = write;

  return makeStats({
    chatHistoryTokensAfter: accHistoryTokens,
    messagesDropped: droppedCount,
    tokensDropped,
  });
}

/**
 * Map SamplerOverrides + advanced settings + reasoning + customBody to API-compatible parameter object.
 *
 * Priority (lowest → highest): sampler overrides → advanced settings → reasoning settings → custom body.
 * Request-level overrides (merged by the caller) take the highest priority.
 */
function buildParameters(
  overrides: SamplerOverrides | null,
  preset: Preset | null,
  reasoningSettings?: {
    apiReasoning?: boolean;
    reasoningEffort?: string;
    thinkingDisplay?: string;
  } | null,
  providerName?: string | null,
  modelName?: string | null,
): Record<string, any> {
  const params: Record<string, any> = {};

  // Streaming toggle — transport-level concern, orthogonal to sampler tuning.
  // Applied regardless of overrides.enabled so users can disable streaming without
  // also opting into sampler overrides. The `_streaming` key is consumed by
  // generate.service.ts and stripped before reaching providers (also in each
  // provider's INTERNAL_PARAMS allowlist as a safety net).
  if (overrides && overrides.streaming === false) {
    params._streaming = false;
  }

  // Sampler overrides — when enabled, apply user values (or defaults for core params).
  // A value of 0 on selected sampling params means "exclude from request", allowing
  // users to avoid provider conflicts (e.g. Claude rejects requests with both
  // temperature and top_p). top_k is handled separately via an explicit UI toggle.
  if (overrides?.enabled) {
    for (const [camelKey, apiKey] of Object.entries(SAMPLER_KEY_MAP)) {
      const val = (overrides as any)[camelKey];
      if (val !== null && val !== undefined) {
        if (val === 0 && ZERO_EXCLUDES_SAMPLER.has(camelKey)) continue;
        params[apiKey] = val;
      } else if (camelKey in SAMPLER_DEFAULTS) {
        // Core params: use the visual default so the request matches what the UI shows
        params[apiKey] = SAMPLER_DEFAULTS[camelKey];
      }
    }
  }

  // Advanced settings from preset.prompts.advancedSettings
  const advancedSettings = preset?.prompts?.advancedSettings;
  if (advancedSettings) {
    if (
      Array.isArray(advancedSettings.customStopStrings) &&
      advancedSettings.customStopStrings.length > 0
    ) {
      params.stop = advancedSettings.customStopStrings;
    }
    if (
      typeof advancedSettings.seed === "number" &&
      advancedSettings.seed >= 0
    ) {
      params.seed = advancedSettings.seed;
    }
  }

  // API-level reasoning: inject provider-specific params when enabled.
  // Placed before custom body so custom body can override with more specific config.
  // For toggle-only providers (Moonshot, Z.AI), always inject when apiReasoning is on.
  if (reasoningSettings?.apiReasoning && providerName) {
    const effort = reasoningSettings.reasoningEffort || "auto";
    const isToggleOnly = providerName === "moonshot" || providerName === "zai";
    if (effort !== "auto" || isToggleOnly) {
      injectReasoningParams(
        params,
        providerName,
        effort,
        modelName || undefined,
        reasoningSettings.thinkingDisplay,
      );
    }
  }

  // Custom body from preset.parameters.customBody
  const customBody = preset?.parameters?.customBody;
  if (customBody?.enabled && customBody.rawJson) {
    try {
      const custom = JSON.parse(customBody.rawJson);
      Object.assign(params, custom);
    } catch {
      // Invalid JSON — skip silently
    }
  }

  // Authoritative off-switch: when the user has disabled API reasoning, strip every
  // provider-specific reasoning field — including anything a customBody spread in —
  // so native thinking is never requested. Most providers use omission as their
  // documented "no extended thinking" default; Claude 4.6/4.7 uses an explicit
  // `thinking: { type: "disabled" }` off-switch below.
  if (reasoningSettings && reasoningSettings.apiReasoning === false) {
    applyProviderReasoningOffSwitch(params, providerName, modelName);
  }

  return params;
}

/**
 * Inject provider-specific reasoning/thinking parameters based on the
 * user's reasoning effort setting. Does NOT override if the parameter
 * is already set (e.g. by a prior custom body or explicit override).
 *
 * Provider mapping:
 * - Anthropic:   thinking + output_config (adaptive 4.6+) or thinking.budget_tokens (legacy).
 *                Opus 4.7 additionally supports an "xhigh" tier between high and max.
 *                Anthropic-only: `thinkingDisplay` ('summarized' | 'omitted') maps to the
 *                `thinking.display` field. On Opus 4.7+ the API defaults to 'omitted' when
 *                unset, so users must opt in to 'summarized' to receive summary text.
 * - Google:      thinkingConfig.thinkingLevel (3.x) or thinkingBudget (2.5)
 * - DeepSeek:    thinking + reasoning_effort (OpenAI-format API). Effort is
 *                normalized to high/max per the official docs.
 * - OpenRouter:  reasoning: { effort } with values: none/minimal/low/medium/high/xhigh
 * - NanoGPT:     reasoning: { effort } with values: none/minimal/low/medium/high.
 *                Object form is used so `reasoning.exclude = true` can suppress
 *                thinking on `:thinking`-suffixed models when the user disables
 *                API reasoning (the `:thinking` suffix activates reasoning
 *                server-side regardless of `reasoning_effort`).
 * - Moonshot:    thinking: { type: "enabled" } — toggle-only, effort ignored
 * - Z.AI:        thinking: { type: "enabled" } — toggle-only, effort ignored
 * - Others:      reasoning: { effort } (generic OpenAI-compatible passthrough)
 */
export function injectReasoningParams(
  params: Record<string, any>,
  providerName: string,
  effort: string,
  model?: string,
  thinkingDisplay?: string,
): void {
  if (providerName === "anthropic") {
    if (!params.thinking) {
      // Claude 4.6+ models support adaptive thinking (recommended over manual budget)
      const isAdaptiveModel =
        model && /claude-(opus|sonnet)-4[-.](6|7)/i.test(model);
      if (isAdaptiveModel) {
        // Adaptive thinking: Claude decides when/how much to think
        params.thinking = { type: "adaptive" };
        // Opus 4.7 adds an "xhigh" tier between high and max; other adaptive models don't support it.
        const isOpus47 = /claude-opus-4[-.]7/i.test(model!);
        const validEfforts = isOpus47
          ? new Set(["low", "medium", "high", "xhigh", "max"])
          : new Set(["low", "medium", "high", "max"]);
        const mappedEffort = validEfforts.has(effort) ? effort : "high";
        const existingOutputConfig =
          params.output_config &&
          typeof params.output_config === "object" &&
          !Array.isArray(params.output_config)
            ? params.output_config
            : {};
        if (existingOutputConfig.effort === undefined) {
          params.output_config = {
            ...existingOutputConfig,
            effort: mappedEffort,
          };
        }
      } else {
        // Legacy extended thinking for older Claude models
        const budgetMap: Record<string, number> = {
          low: 2048,
          medium: 8192,
          high: 16384,
          max: 32768,
        };
        const budget = budgetMap[effort] || 8192;
        params.thinking = { type: "enabled", budget_tokens: budget };
      }
    }
    if (thinkingDisplay === "summarized" || thinkingDisplay === "omitted") {
      if (
        params.thinking &&
        typeof params.thinking === "object" &&
        params.thinking.display === undefined
      ) {
        params.thinking.display = thinkingDisplay;
      }
    }
  } else if (providerName === "google" || providerName === "google_vertex") {
    // Google Gemini / Vertex AI: thinkingConfig with thinkingLevel
    // Valid levels: minimal, low, medium, high
    const validLevels = new Set(["minimal", "low", "medium", "high"]);
    const existing =
      params.thinkingConfig && typeof params.thinkingConfig === "object"
        ? params.thinkingConfig
        : {};
    // Merge: preserve any user-supplied thinkingLevel/thinkingBudget, but
    // always set includeThoughts: true so the API actually returns thought
    // summary parts (without this flag, Gemini reasons internally but
    // emits zero `part.thought` parts and our parser sees nothing).
    params.thinkingConfig = {
      ...existing,
      thinkingLevel:
        existing.thinkingLevel ?? (validLevels.has(effort) ? effort : "medium"),
      includeThoughts: true,
    };
  } else if (providerName === "openrouter") {
    // OpenRouter: unified reasoning object with effort levels
    // Valid: none, minimal, low, medium, high, xhigh
    if (!params.reasoning) {
      const validEfforts = new Set([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      params.reasoning = { effort: validEfforts.has(effort) ? effort : "high" };
    }
  } else if (providerName === "deepseek") {
    // DeepSeek's official OpenAI-format API expects a top-level `thinking`
    // toggle and top-level `reasoning_effort`, not Anthropic-style
    // `output_config` and not the generic `reasoning: { effort }` object.
    // Docs: low/medium -> high, xhigh -> max.
    if (!params.thinking) {
      params.thinking = { type: "enabled" };
    }

    if (params.reasoning_effort === undefined) {
      let mappedEffort = "high";
      if (effort === "max" || effort === "xhigh") mappedEffort = "max";
      else if (effort === "high" || effort === "medium" || effort === "low")
        mappedEffort = "high";
      params.reasoning_effort = mappedEffort;
    }

    // Avoid sending the generic compatibility shape alongside DeepSeek's
    // official reasoning controls.
    delete params.reasoning;
  } else if (providerName === "nanogpt") {
    // NanoGPT: object form `reasoning: { effort }` — docs state top-level
    // `reasoning_effort` and nested `reasoning.effort` are equivalent, but the
    // object form is the only one that also exposes `exclude` (strip reasoning
    // from the response) and `delta_field` (legacy `reasoning_content` streams).
    // Valid efforts: none, minimal, low, medium, high.
    const validEfforts = new Set(["none", "minimal", "low", "medium", "high"]);
    const mappedEffort = validEfforts.has(effort) ? effort : "high";
    const existing =
      params.reasoning && typeof params.reasoning === "object"
        ? params.reasoning
        : {};
    if (existing.effort === undefined) {
      params.reasoning = { ...existing, effort: mappedEffort };
    }
    // Avoid sending both forms — the object form we just set is authoritative.
    delete params.reasoning_effort;
  } else if (providerName === "moonshot" || providerName === "zai") {
    // Toggle-only providers: thinking is enabled/disabled, no effort granularity.
    // The "Request Reasoning" toggle controls this — effort is ignored.
    if (!params.thinking) {
      params.thinking = { type: "enabled" };
    }
  } else {
    // Generic OpenAI-compatible providers (OpenAI, xAI, etc.)
    // reasoning: { effort } is the standard format for reasoning-capable models.
    if (!params.reasoning) {
      params.reasoning = { effort };
    }
  }
}

function stripAnthropicReasoningOutputConfig(
  outputConfig: unknown,
): Record<string, any> | undefined {
  if (
    !outputConfig ||
    typeof outputConfig !== "object" ||
    Array.isArray(outputConfig)
  )
    return undefined;
  const next = { ...(outputConfig as Record<string, any>) };
  delete next.effort;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function applyProviderReasoningOffSwitch(
  params: Record<string, any>,
  providerName?: string | null,
  modelName?: string | null,
): void {
  delete params.thinking;
  delete params.thinkingConfig;
  delete params.reasoning;
  delete params.reasoning_effort;

  if (providerName === "anthropic") {
    const nextOutputConfig = stripAnthropicReasoningOutputConfig(
      params.output_config,
    );
    if (nextOutputConfig) params.output_config = nextOutputConfig;
    else delete params.output_config;

    if (modelName && /claude-(opus|sonnet)-4[-.](6|7)/i.test(modelName)) {
      params.thinking = { type: "disabled" };
    }
    return;
  }

  delete params.output_config;

  if (providerName === "deepseek") {
    params.thinking = { type: "disabled" };
    return;
  }

  if (providerName === "nanogpt") {
    params.reasoning = { exclude: true };
  }
}

/**
 * One-liner impersonation: skip all preset blocks, include only chat history
 * and the impersonation prompt from preset behaviors. Optionally includes the
 * assistantImpersonation prefill as a trailing assistant message.
 */
async function onelinerImpersonation(
  messages: Message[],
  character: Character,
  persona: Persona | null,
  chat: Chat,
  connection: ConnectionProfile | null,
  preset: Preset | null,
  promptBehavior: PromptBehavior,
  completionSettings: CompletionSettings,
  samplerOverrides: SamplerOverrides | null,
  ctx: AssemblyContext,
  macroEnv: MacroEnv,
  reasoningSettings?: {
    apiReasoning?: boolean;
    reasoningEffort?: string;
    thinkingDisplay?: string;
  } | null,
): Promise<AssemblyResult> {
  const result: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];

  // Chat history
  let messageCount = 0;
  const historyParts: string[] = [];
  let impHistYieldCounter = 0;
  for (const msg of messages) {
    if (msg.extra?.hidden === true) continue;
    if ((impHistYieldCounter++ & 15) === 0) {
      await yieldAndCheckAbort(ctx.signal);
    } else if (ctx.signal?.aborted) {
      throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const role: "user" | "assistant" = msg.is_user ? "user" : "assistant";
    const resolvedContent = healFormattingArtifacts(
      (await evaluate(msg.content, macroEnv, registry)).text,
    );
    result.push({ role, content: resolvedContent });
    historyParts.push(resolvedContent);
    messageCount++;
  }
  breakdown.push({
    type: "chat_history",
    name: "Chat History",
    messageCount,
    content: historyParts.join("\n"),
  });

  // Impersonation prompt
  const prompt = promptBehavior.impersonationPrompt;
  const userInput =
    typeof ctx.impersonateInput === "string" ? ctx.impersonateInput.trim() : "";
  let resolved = "";
  if (prompt) {
    resolved = (await evaluate(prompt, macroEnv, registry)).text;
  }
  if (userInput) {
    resolved = resolved ? `${resolved}\n\n${userInput}` : userInput;
  }
  if (resolved) {
    result.push({ role: "system", content: resolved });
    breakdown.push({
      type: "utility",
      name: "Impersonation Prompt",
      role: "system",
      content: resolved,
    });
  }

  // assistantImpersonation prefill — sent as actual assistant message
  let assistantPrefill: string | undefined;
  const csPrefill =
    completionSettings.assistantImpersonation ||
    completionSettings.assistantPrefill;
  if (csPrefill) {
    const resolvedPrefill = (await evaluate(csPrefill, macroEnv, registry))
      .text;
    if (resolvedPrefill) {
      assistantPrefill = resolvedPrefill;
      result.push({ role: "assistant", content: assistantPrefill });
      breakdown.push({
        type: "utility",
        name: "Assistant Prefill",
        role: "assistant",
        content: assistantPrefill,
      });
    }
  }

  // Build parameters from sampler overrides + reasoning settings
  const parameters = buildParameters(
    samplerOverrides,
    preset,
    reasoningSettings,
    connection?.provider,
    connection?.model,
  );

  return {
    messages: result,
    breakdown,
    parameters,
    assistantPrefill,
    macroEnv,
  };
}

/**
 * Legacy assembly: simple message mapping with no preset.
 * Includes character card as system prompt for usable generation.
 */
async function legacyAssembly(
  messages: Message[],
  generationType: GenerationType,
  character?: Character | null,
  persona?: Persona | null,
  chat?: Chat | null,
  connection?: ConnectionProfile | null,
  userId?: string,
  signal?: AbortSignal,
): Promise<AssemblyResult> {
  const llmMessages: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];

  // Initialize macros for legacy path too
  initMacros();
  let macroEnv: MacroEnv | null = null;
  if (character && chat) {
    const chatObj = chat as Chat;
    const groupNames = userId
      ? resolveGroupCharacterNames(chatObj, (cid) => {
          const char = charactersSvc.getCharacter(userId, cid);
          return char ? getEffectiveCharacterName(char) : undefined;
        })
      : undefined;
    const isGroup = !!chatObj.metadata?.group;
    const legacyMutedIds = userId ? chatsSvc.getGroupMutedIds(chatObj) : [];
    const legacyNotMuted =
      groupNames && legacyMutedIds.length > 0 && userId
        ? resolveGroupCharacterNames(chatObj, (cid) => {
            if (legacyMutedIds.includes(cid)) return undefined;
            const char = charactersSvc.getCharacter(userId, cid);
            return char ? getEffectiveCharacterName(char) : undefined;
          })
        : undefined;
    // Resolve alternate field overrides and group scenario override (legacy path)
    const legacyEffectiveChar = userId
      ? resolveGroupScenarioOverride(
          resolveCharacterWithAlternateFields(character as Character, chatObj),
          chatObj,
          userId,
        )
      : resolveCharacterWithAlternateFields(character as Character, chatObj);

    macroEnv = buildEnv({
      character: legacyEffectiveChar,
      persona: persona ?? null,
      chat: chatObj,
      messages,
      generationType,
      connection: connection ?? null,
      groupCharacterNames: groupNames,
      groupNotMutedNames: legacyNotMuted,
      targetCharacterName: isGroup
        ? getEffectiveCharacterName(legacyEffectiveChar)
        : undefined,
      signal,
    });
    // Populate reasoning macros
    if (userId) {
      const reasoningSetting = settingsSvc.getSetting(
        userId,
        "reasoningSettings",
      );
      if (reasoningSetting?.value) {
        macroEnv.extra.reasoningPrefix = reasoningSetting.value.prefix ?? "";
        macroEnv.extra.reasoningSuffix = reasoningSetting.value.suffix ?? "";
      }
      // Populate theme info for {{userColorMode}} macro (legacy path)
      const themeSetting = settingsSvc.getSetting(userId, "theme");
      if (themeSetting?.value) {
        macroEnv.extra.theme = { mode: themeSetting.value.mode ?? "dark" };
      }
      // Populate Lumia / Loom context (legacy path)
      if (chat) populateLumiaLoomContext(macroEnv, userId, chat as Chat);
    }
  }

  const resolveMacros = async (text: string): Promise<string> => {
    if (macroEnv) return (await evaluate(text, macroEnv, registry)).text;
    return text;
  };

  // Build a system prompt from the character card (use effective character for alternate fields + group scenario)
  let legacyChar =
    character && chat
      ? resolveCharacterWithAlternateFields(
          character as Character,
          chat as Chat,
        )
      : character;
  if (legacyChar && chat && userId) {
    legacyChar = resolveGroupScenarioOverride(
      legacyChar as Character,
      chat as Chat,
      userId,
    );
  }
  const systemParts: string[] = [];
  if (legacyChar?.description) systemParts.push(legacyChar.description);
  if (legacyChar?.personality)
    systemParts.push(`Personality: ${legacyChar.personality}`);
  if (legacyChar?.scenario)
    systemParts.push(`Scenario: ${legacyChar.scenario}`);
  if (persona?.description)
    systemParts.push(`[User persona: ${persona.description}]`);

  if (systemParts.length > 0) {
    const systemContent = await resolveMacros(systemParts.join("\n\n"));
    llmMessages.push({ role: "system", content: systemContent });
    breakdown.push({
      type: "block",
      name: "Character Card (legacy)",
      role: "system",
      content: systemContent,
    });
  }

  for (const block of getDreamWeaverRuntimeBlocks(legacyChar as Character)) {
    llmMessages.push({ role: "system", content: block.content });
    breakdown.push({
      type: "block",
      name: block.name,
      role: "system",
      content: block.content,
    });
  }

  // Add dialogue examples if present
  if (character?.mes_example) {
    const examples = character.mes_example.trim();
    if (examples) {
      const resolvedExamples = await resolveMacros(
        `Example dialogue:\n${examples}`,
      );
      llmMessages.push({ role: "system", content: resolvedExamples });
      breakdown.push({
        type: "block",
        name: "Dialogue Examples (legacy)",
        role: "system",
        content: resolvedExamples,
      });
    }
  }

  if (userId && chat) {
    const legacyMemoryResult = await safeCollectChatVectorMemory(
      userId,
      chat.id,
      messages,
    );
    if (legacyMemoryResult.count > 0) {
      const memoryContent = legacyMemoryResult.formatted;
      llmMessages.push({ role: "system", content: memoryContent });
      breakdown.push({
        type: "long_term_memory",
        name: "Long-Term Memory",
        role: "system",
        content: memoryContent,
      });
    }
  }

  // Chat history — evaluate macros in each message
  // Skip messages marked as hidden drafts (extra.hidden === true)
  // Pre-resolve all attachment files in parallel (same pattern as main assembly)
  const legacyAttachmentIds = new Set<string>();
  for (const m of messages) {
    if (m.extra?.hidden === true) continue;
    const atts = Array.isArray(m.extra?.attachments) ? m.extra.attachments : [];
    for (const att of atts) {
      if (att.image_id) legacyAttachmentIds.add(att.image_id as string);
    }
  }
  const legacyAttachmentCache = new Map<string, string | null>();
  if (legacyAttachmentIds.size > 0 && userId) {
    const entries = await Promise.all(
      [...legacyAttachmentIds].map(
        async (id) => [id, await resolveAttachmentBase64(userId, id)] as const,
      ),
    );
    for (const [id, b64] of entries) legacyAttachmentCache.set(id, b64);
  }

  const legacyFirstChatIdx = llmMessages.length;
  let legacyHistoryCount = 0;
  const legacyHistoryParts: string[] = [];
  let legacyHistYieldCounter = 0;
  for (const m of messages) {
    if (m.extra?.hidden === true) continue;
    if ((legacyHistYieldCounter++ & 15) === 0) {
      await yieldAndCheckAbort(signal);
    } else if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const resolved = healFormattingArtifacts(await resolveMacros(m.content));
    legacyHistoryParts.push(resolved);
    const attachments = Array.isArray(m.extra?.attachments)
      ? m.extra.attachments
      : [];
    if (attachments.length > 0) {
      const parts: import("../llm/types").LlmMessagePart[] = [];
      if (resolved.trim().length > 0) {
        parts.push({ type: "text", text: resolved });
      }
      for (const att of attachments) {
        if (!att.image_id || !userId) continue;
        const b64 = legacyAttachmentCache.get(att.image_id as string) ?? null;
        if (!b64) continue;
        if (att.type === "image") {
          parts.push({ type: "image", data: b64, mime_type: att.mime_type });
        } else if (att.type === "audio") {
          parts.push({ type: "audio", data: b64, mime_type: att.mime_type });
        }
      }
      llmMessages.push({
        role: (m.is_user ? "user" : "assistant") as LlmMessage["role"],
        content: parts.length > 0 ? parts : resolved,
      });
    } else {
      llmMessages.push({
        role: (m.is_user ? "user" : "assistant") as LlmMessage["role"],
        content: resolved,
      });
    }
    legacyHistoryCount++;
  }
  breakdown.push({
    type: "chat_history",
    name: "Chat History (legacy)",
    messageCount: legacyHistoryCount,
    content: legacyHistoryParts.join("\n"),
  });

  // Merge consecutive user messages (queued messages) into single LLM turns
  legacyHistoryCount = mergeConsecutiveUserMessages(
    llmMessages,
    legacyFirstChatIdx,
    legacyHistoryCount,
  );

  // Strip reasoning from older chat history messages based on keepInHistory
  let reasoningVal: {
    apiReasoning?: boolean;
    reasoningEffort?: string;
    thinkingDisplay?: string;
  } | null = null;
  if (userId) {
    const reasoningSetting = settingsSvc.getSetting(
      userId,
      "reasoningSettings",
    );
    if (reasoningSetting?.value) {
      stripReasoningFromChatHistory(
        llmMessages,
        legacyFirstChatIdx,
        legacyHistoryCount,
        reasoningSetting.value,
      );
      reasoningVal = reasoningSetting.value;
    }

    // Apply context filters (details blocks, loom tags, HTML tags)
    const contextFiltersSetting = settingsSvc.getSetting(
      userId,
      "contextFilters",
    );
    if (contextFiltersSetting?.value) {
      applyContextFilters(
        llmMessages,
        legacyFirstChatIdx,
        legacyHistoryCount,
        contextFiltersSetting.value as ContextFilters,
      );
    }
  }

  // Drop empty text parts or empty messages to avoid proxy/provider errors
  stripEmptyTextParts(llmMessages);

  // Build parameters with reasoning settings so API-level reasoning is injected
  const parameters = buildParameters(
    null,
    null,
    reasoningVal,
    connection?.provider,
    connection?.model,
  );

  return {
    messages: llmMessages,
    breakdown,
    parameters,
    macroEnv: macroEnv ?? undefined,
  };
}
