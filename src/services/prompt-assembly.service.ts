import { getTextContent, type LlmMessage, type AssemblyContext, type AssemblyResult, type AssemblyBreakdownEntry, type GenerationType, type ActivatedWorldInfoEntry } from "../llm/types";
import type { PromptBlock, PromptBehavior, CompletionSettings, SamplerOverrides, AuthorsNote } from "../types/preset";
import type { WorldInfoCache } from "../types/world-book";
import type { Character } from "../types/character";
import type { Persona } from "../types/persona";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { Preset } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import { evaluate, buildEnv, registry, initMacros } from "../macros";
import type { MacroEnv } from "../macros";
import { activateWorldInfo, type WiState } from "./world-info-activation.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as worldBooksSvc from "./world-books.service";
import * as settingsSvc from "./settings.service";
import * as packsSvc from "./packs.service";
import * as embeddingsSvc from "./embeddings.service";
import * as imagesSvc from "./images.service";
import { getCouncilSettings } from "./council/council-settings.service";
import { getDb } from "../db/connection";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Attachment resolution — read image/audio files from disk into base64
// ---------------------------------------------------------------------------

function resolveAttachmentBase64(userId: string, imageId: string): string | null {
  const filePath = imagesSvc.getImageFilePath(userId, imageId, false);
  if (!filePath) return null;
  try {
    const buffer = readFileSync(filePath);
    return buffer.toString("base64");
  } catch {
    return null;
  }
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
 * maxTokens and contextSize are excluded — 0 is never a valid intent for those.
 */
const ZERO_EXCLUDES_SAMPLER = new Set([
  "temperature",
  "topP",
  "minP",
  "topK",
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
  return role === 'user_append' || role === 'assistant_append';
}

function appendBaseRole(role: string): 'user' | 'assistant' {
  return role === 'user_append' ? 'user' : 'assistant';
}

interface PendingAppend {
  baseRole: 'user' | 'assistant';
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
export async function assemblePrompt(ctx: AssemblyContext): Promise<AssemblyResult> {
  // ---- Load data ----
  const chat = chatsSvc.getChat(ctx.userId, ctx.chatId);
  if (!chat) throw new Error("Chat not found");

  const messages = chatsSvc.getMessages(ctx.userId, ctx.chatId);
  // For group chats, resolve the target character; fall back to the chat's primary character
  const characterId = ctx.targetCharacterId || chat.character_id;
  const character = charactersSvc.getCharacter(ctx.userId, characterId);
  if (!character) throw new Error("Character not found");

  const persona = personasSvc.resolvePersonaOrDefault(ctx.userId, ctx.personaId);

  // Resolve connection
  const connection = ctx.connectionId
    ? connectionsSvc.getConnection(ctx.userId, ctx.connectionId)
    : connectionsSvc.getDefaultConnection(ctx.userId);

  // Resolve preset: request presetId takes priority, then connection's preset_id
  const resolvedPresetId = ctx.presetId || connection?.preset_id;
  let preset: Preset | null = null;
  if (resolvedPresetId) {
    preset = presetsSvc.getPreset(ctx.userId, resolvedPresetId);
  }

  // Extract Loom structures from preset
  const blocks: PromptBlock[] = preset?.prompt_order ?? [];
  const prompts = preset?.prompts ?? {};
  const promptBehavior: PromptBehavior = prompts.promptBehavior ?? {};
  const completionSettings: CompletionSettings = prompts.completionSettings ?? {};
  const samplerOverrides: SamplerOverrides | null = preset?.parameters?.samplerOverrides ?? null;

  // If no blocks, fall back to legacy mapping
  if (!blocks.length) {
    return await legacyAssembly(messages, ctx.generationType, character, persona, chat, connection, ctx.userId);
  }

  // ---- World Info activation ----
  const globalWorldBooks = (settingsSvc.getSetting(ctx.userId, "globalWorldBooks")?.value as string[] | undefined) ?? [];
  const wiSources = collectWorldInfoSources(ctx.userId, character, persona, globalWorldBooks);
  const wiEntries = wiSources.entries;
  const wiState: WiState = (chat.metadata?.wi_state as WiState) ?? {};
  const wiResult = activateWorldInfo({
    entries: wiEntries,
    messages,
    chatTurn: messages.length,
    wiState,
  });
  const wiCache = wiResult.cache;

  // Build activated world info summary (keyword-activated entries first)
  const activatedWorldInfo: ActivatedWorldInfoEntry[] = wiResult.activatedEntries.map((e) => ({
    id: e.id,
    comment: e.comment || '',
    keys: e.key || [],
    source: 'keyword' as const,
  }));

  // Optional vector retrieval for vectorized world book entries.
  // These entries are merged with keyword-activated entries when enabled.
  // When pre-computed results are available (from the generation pipeline's
  // council enrichment phase), reuse them to avoid redundant embedding queries.
  const vectorActivated = ctx.precomputedVectorEntries
    ?? await collectVectorActivatedWorldInfo(
      ctx.userId,
      wiSources.worldBookIds,
      wiEntries,
      messages,
    );
  if (vectorActivated.length > 0) {
    const existing = new Set(wiResult.activatedEntries.map((e) => e.id));
    for (const { entry, score } of vectorActivated) {
      if (existing.has(entry.id)) continue;
      injectEntryIntoCache(wiCache, entry);
      wiResult.activatedEntries.push(entry);
      existing.add(entry.id);
      activatedWorldInfo.push({
        id: entry.id,
        comment: entry.comment || '',
        keys: entry.key || [],
        source: 'vector',
        score,
      });
    }
  }

  // ---- Defer WI state persistence to after generation ----
  const deferredWiState = {
    chatId: chat.id,
    metadata: { ...chat.metadata, wi_state: wiResult.wiState },
  };

  // ---- Macro engine ----
  initMacros();
  const macroEnv: MacroEnv = buildEnv({
    character,
    persona,
    chat,
    messages,
    generationType: ctx.generationType,
    connection,
  });

  // Batch-load all settings needed for assembly in a single query
  const settingsKeys = [
    "reasoningSettings",
    "selectedDefinition", "selectedBehaviors", "selectedPersonalities",
    "chimeraMode", "lumiaQuirks", "lumiaQuirksEnabled",
    "oocEnabled", "lumiaOOCInterval", "lumiaOOCStyle",
    "sovereignHand",
    "selectedLoomStyles", "selectedLoomUtils", "selectedLoomRetrofits",
    "guidedGenerations", "promptBias",
    "theme",
    "contextFilters",
  ];
  const settingsMap = settingsSvc.getSettingsByKeys(ctx.userId, settingsKeys);

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
  if (ctx.generationType === "impersonate" && ctx.impersonateMode === "oneliner") {
    return await onelinerImpersonation(messages, character, persona, chat, connection, preset, promptBehavior, completionSettings, samplerOverrides, ctx, macroEnv, reasoningVal);
  }

  // ---- Assembly loop ----
  const result: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];
  const pendingAppends: PendingAppend[] = [];
  let chatHistoryInserted = false;
  let hasWiBefore = false;
  let hasWiAfter = false;
  let firstChatIdx = -1;

  for (const block of blocks) {
    // Skip disabled blocks
    if (!block.enabled) continue;

    // Skip category markers only if they carry no content
    if (block.marker === "category" && !block.content?.trim()) continue;

    // Injection trigger filtering — if block specifies triggers, skip if current
    // generation type is not in the list
    if (block.injectionTrigger && block.injectionTrigger.length > 0) {
      if (!block.injectionTrigger.includes(ctx.generationType)) continue;
    }

    // ---- Handle by marker type ----

    if (block.marker === "chat_history") {
      const chatVectorMemories = await collectChatVectorMemory(ctx.userId, ctx.chatId, messages);
      if (chatVectorMemories.length > 0) {
        const memoryContent = "Past Memories (for context only):\n" + chatVectorMemories.join("\n\n");
        result.push({ role: "system", content: memoryContent });
        breakdown.push({ type: "long_term_memory", name: "Long-Term Memory", role: "system", content: memoryContent });
      }

      // Insert new-chat separator if configured
      const newChatPrompt = promptBehavior.newChatPrompt;
      if (newChatPrompt) {
        const resolved = (await evaluate(newChatPrompt, macroEnv, registry)).text;
        if (resolved) {
          result.push({ role: "system", content: resolved });
          breakdown.push({ type: "separator", name: "New Chat Prompt", role: "system", content: resolved });
        }
      }

      firstChatIdx = result.length;

      // Insert all chat messages — evaluate macros in each message's content
      // For regenerate: skip the target message (it has a blank swipe)
      // Also skip messages marked as hidden drafts (extra.hidden === true)
      let historyCount = 0;
      const historyParts: string[] = [];
      for (const msg of messages) {
        if (ctx.excludeMessageId && msg.id === ctx.excludeMessageId) continue;
        if (msg.extra?.hidden === true) continue;
        const role: "user" | "assistant" = msg.is_user ? "user" : "assistant";
        const resolvedContent = (await evaluate(msg.content, macroEnv, registry)).text;
        historyParts.push(resolvedContent);
        const attachments = Array.isArray(msg.extra?.attachments) ? msg.extra.attachments : [];
        if (attachments.length > 0) {
          // Build multipart content: text + attachment parts
          const parts: import("../llm/types").LlmMessagePart[] = [{ type: "text", text: resolvedContent }];
          for (const att of attachments) {
            const b64 = resolveAttachmentBase64(ctx.userId, att.image_id);
            if (!b64) continue;
            if (att.type === "image") {
              parts.push({ type: "image", data: b64, mime_type: att.mime_type });
            } else if (att.type === "audio") {
              parts.push({ type: "audio", data: b64, mime_type: att.mime_type });
            }
          }
          result.push({ role, content: parts });
        } else {
          result.push({ role, content: resolvedContent });
        }
        historyCount++;
      }
      breakdown.push({ type: "chat_history", name: "Chat History", messageCount: historyCount, firstMessageIndex: firstChatIdx, content: historyParts.join("\n") });
      chatHistoryInserted = true;

      // Strip reasoning from older chat history messages based on keepInHistory
      if (reasoningVal) {
        stripReasoningFromChatHistory(result, firstChatIdx, historyCount, reasoningVal);
      }

      // Apply context filters (details blocks, loom tags, HTML tags)
      const contextFiltersVal = settingsMap.get("contextFilters") as ContextFilters | undefined;
      if (contextFiltersVal) {
        applyContextFilters(result, firstChatIdx, historyCount, contextFiltersVal);
      }
      continue;
    }

    if (block.marker === "world_info_before") {
      hasWiBefore = true;
      if (wiCache.before.length > 0) {
        for (const entry of wiCache.before) {
          const role = (block.role as LlmMessage["role"]) || entry.role;
          result.push({ role, content: entry.content });
          breakdown.push({ type: "world_info", name: "World Info Before", role, content: entry.content });
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
          breakdown.push({ type: "world_info", name: "World Info After", role, content: entry.content });
        }
      }
      continue;
    }

    // Structural markers → resolve via macro
    if (block.marker && STRUCTURAL_MARKERS.has(block.marker) && MARKER_TO_MACRO[block.marker]) {
      const macro = MARKER_TO_MACRO[block.marker];
      const resolved = (await evaluate(macro, macroEnv, registry)).text.trim();
      if (resolved) {
        const role = (block.role || "system") as LlmMessage["role"];
        result.push({ role, content: resolved });
        breakdown.push({
          type: "block", name: block.name, role: block.role,
          content: resolved, blockId: block.id, marker: block.marker,
        });
      }
      continue;
    }

    // Content-bearing markers and regular blocks → resolve block.content
    const content = block.content || "";
    const rawResolved = (await evaluate(content, macroEnv, registry)).text;
    const resolved = rawResolved.trim();
    if (resolved) {
      // Append roles: collect for deferred application after full assembly
      // Preserve original whitespace (especially leading newlines) for formatting
      if (isAppendRole(block.role)) {
        pendingAppends.push({
          baseRole: appendBaseRole(block.role),
          depth: block.depth || 0,
          content: rawResolved,
          blockName: block.name,
          blockId: block.id,
        });
        continue;
      }
      const role: LlmMessage["role"] = block.position === "post_history" ? "assistant" : (block.role as LlmMessage["role"] || "system");
      result.push({ role, content: resolved });
      breakdown.push({
        type: "block", name: block.name, role,
        content: resolved, blockId: block.id, marker: block.marker ?? undefined,
      });
    }
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

  // Count how many chat messages were inserted (from chat_history block)
  const chatMsgCount = messages.filter((m) =>
    !(ctx.excludeMessageId && m.id === ctx.excludeMessageId) && !(m.extra?.hidden === true)
  ).length;
  const lastChatIdx = firstChatIdx >= 0 ? firstChatIdx + chatMsgCount : result.length;

  // Position 0: "before" — insert just before chat history
  if (!hasWiBefore && wiCache.before.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx : 0;
    const inserted = injectWorldInfoAt(result, breakdown, wiCache.before, insertAt, "World Info Before (auto)");
    // Shift all subsequent anchors since we inserted before the chat block
    if (firstChatIdx >= 0) firstChatIdx += inserted;
  }

  // Position 1: "after" — insert just after chat history
  if (!hasWiAfter && wiCache.after.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx + chatMsgCount : result.length;
    injectWorldInfoAt(result, breakdown, wiCache.after, Math.min(insertAt, result.length), "World Info After (auto)");
  }

  // Positions 2-3 (AN before/after): inject around the start of chat history
  if (wiCache.anBefore.length > 0 && firstChatIdx >= 0) {
    const inserted = injectWorldInfoAt(result, breakdown, wiCache.anBefore, firstChatIdx, "WI AN Before");
    firstChatIdx += inserted;
  }
  if (wiCache.anAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(result, breakdown, wiCache.anAfter, Math.min(insertAt, result.length), "WI AN After");
  }

  // Positions 5-6 (EM before/after): inject around the start of chat history
  if (wiCache.emBefore.length > 0 && firstChatIdx >= 0) {
    injectWorldInfoAt(result, breakdown, wiCache.emBefore, firstChatIdx, "WI EM Before");
  }
  if (wiCache.emAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(result, breakdown, wiCache.emAfter, Math.min(insertAt, result.length), "WI EM After");
  }

  // Position 4 (depth-based): insert at result.length - depth
  for (const depthEntry of wiCache.depth) {
    const insertAt = Math.max(0, result.length - depthEntry.depth);
    const role = depthEntry.role as LlmMessage["role"];
    result.splice(insertAt, 0, { role, content: depthEntry.content });
    breakdown.push({ type: "world_info", name: `WI Depth ${depthEntry.depth}`, role: depthEntry.role, content: depthEntry.content });
  }

  // ---- Author's Note injection ----
  const authorsNote: AuthorsNote | null = chat.metadata?.authors_note ?? null;
  if (authorsNote && authorsNote.content) {
    const resolvedAN = (await evaluate(authorsNote.content, macroEnv, registry)).text;
    if (resolvedAN) {
      const insertAt = Math.max(0, result.length - (authorsNote.depth || 4));
      result.splice(insertAt, 0, { role: authorsNote.role || "system", content: resolvedAN });
      breakdown.push({ type: "authors_note", name: "Author's Note", role: authorsNote.role, content: resolvedAN });
    }
  }

  // ---- Utility prompt injection ----

  // Guided generations (from batch-loaded settings)
  const guided = normalizeGuidedGenerations(settingsMap.get("guidedGenerations"));
  if (guided.length > 0) {
    await applyGuidedGenerations(result, guided, macroEnv, breakdown);
  }

  // Continue type: append continueNudge (unless continuePrefill is on)
  if (ctx.generationType === "continue" && !completionSettings.continuePrefill) {
    const nudge = promptBehavior.continueNudge;
    if (nudge) {
      const resolved = (await evaluate(nudge, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "system", content: resolved });
        breakdown.push({ type: "utility", name: "Continue Nudge", role: "system", content: resolved });
      }
    }
  }

  // Continue type: apply continuePostfix to last assistant message
  if (ctx.generationType === "continue" && completionSettings.continuePostfix) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "assistant") {
        result[i] = { ...result[i], content: result[i].content + completionSettings.continuePostfix };
        break;
      }
    }
  }

  // Impersonate type: append impersonation prompt
  if (ctx.generationType === "impersonate") {
    const prompt = promptBehavior.impersonationPrompt;
    if (prompt) {
      const resolved = (await evaluate(prompt, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "system", content: resolved });
        breakdown.push({ type: "utility", name: "Impersonation Prompt", role: "system", content: resolved });
      }
    }
  }

  // sendIfEmpty: if last message in result is assistant role and content is blank-ish
  if (promptBehavior.sendIfEmpty && result.length > 0) {
    const last = result[result.length - 1];
    if (last.role === "assistant" && typeof last.content === "string" && !last.content.trim()) {
      const resolved = (await evaluate(promptBehavior.sendIfEmpty, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "user", content: resolved });
        breakdown.push({ type: "utility", name: "Send If Empty", role: "user", content: resolved });
      }
    }
  }

  // ---- Build user nudge (replaces assistant prefill for universal compatibility) ----
  // Instead of appending an assistant prefill (which some models reject),
  // we always inject a silent user nudge so the conversation ends with a user message.
  const nudgeParts: string[] = [];

  // Group chat nudge from preset (e.g. "[Write next reply only as {{char}}]")
  if (ctx.targetCharacterId) {
    const groupNudge = promptBehavior.groupNudge;
    if (groupNudge) {
      const resolved = (await evaluate(groupNudge, macroEnv, registry)).text;
      if (resolved) nudgeParts.push(resolved);
    }
  }

  // promptBias (Start Reply With) — folded into the nudge as guidance
  const promptBiasVal = settingsMap.get("promptBias");
  if (promptBiasVal && typeof promptBiasVal === "string" && promptBiasVal.trim()) {
    const resolvedBias = (await evaluate(promptBiasVal, macroEnv, registry)).text;
    if (resolvedBias) nudgeParts.push(`Begin your reply with: ${resolvedBias}`);
  }

  // assistantPrefill / assistantImpersonation — folded into the nudge as guidance
  const csPrefill = (ctx.generationType === "impersonate" && completionSettings.assistantImpersonation)
    ? completionSettings.assistantImpersonation
    : completionSettings.assistantPrefill;
  if (csPrefill) {
    const resolvedPrefill = (await evaluate(csPrefill, macroEnv, registry)).text;
    if (resolvedPrefill) nudgeParts.push(`Begin your reply with: ${resolvedPrefill}`);
  }

  // Ensure the conversation always ends with a user message
  if (nudgeParts.length > 0) {
    const nudgeContent = nudgeParts.join("\n");
    result.push({ role: "user", content: nudgeContent });
    breakdown.push({ type: "utility", name: "User Nudge", role: "user", content: nudgeContent });
  } else if (ctx.generationType === "continue" && result.length > 0 && result[result.length - 1].role === "assistant") {
    // Continue generation with no explicit nudge — add a minimal nudge so the
    // conversation ends on a user message (required by most providers).
    result.push({ role: "user", content: "[Continue]" });
    breakdown.push({ type: "utility", name: "User Nudge", role: "user", content: "[Continue]" });
  }

  // ---- Apply CompletionSettings post-processing (excluding prefill, handled above) ----
  applyCompletionSettings(result, completionSettings, character, persona, ctx.generationType);

  // ---- Apply pending append blocks ----
  for (const append of pendingAppends) {
    applyAppendBlock(result, breakdown, append);
  }

  // ---- Build parameters from sampler overrides + advanced settings + reasoning + custom body ----
  const parameters = buildParameters(samplerOverrides, preset, reasoningVal, connection?.provider, connection?.model);

  // Include Usage: internal flag so providers request token usage data in streams
  if (completionSettings.includeUsage) {
    parameters._include_usage = true;
  }

  return {
    messages: result,
    breakdown,
    parameters,
    activatedWorldInfo: activatedWorldInfo.length > 0 ? activatedWorldInfo : undefined,
    deferredWiState,
    deliberationHandledByMacro: !!(macroEnv.extra as any)._deliberationMacroUsed,
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
    const position = g.position === "user_prefix" || g.position === "user_suffix" ? g.position : "system";
    out.push({
      id: typeof g.id === "string" ? g.id : "",
      name: typeof g.name === "string" && g.name.trim() ? g.name : "Guided Generation",
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
    const resolved = (await evaluate(guide.content, macroEnv, registry)).text.trim();
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
    breakdown.push({ type: "utility", name: "Guided Generations (system)", role: "system", content: systemInjections.join("\n\n") });
  }

  if (prefixes.length > 0 || suffixes.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role !== "user") continue;
      const prefix = prefixes.length > 0 ? `${prefixes.join("\n")}\n` : "";
      const suffix = suffixes.length > 0 ? `\n${suffixes.join("\n")}` : "";
      if (typeof result[i].content === "string") {
        result[i] = { ...result[i], content: `${prefix}${result[i].content}${suffix}` };
      } else {
        // Multipart: prepend/append to the text part
        const parts = [...result[i].content as import("../llm/types").LlmMessagePart[]];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
          parts[textIdx] = { type: "text", text: `${prefix}${tp.text}${suffix}` };
        } else {
          parts.unshift({ type: "text", text: `${prefix}${suffix}` });
        }
        result[i] = { ...result[i], content: parts };
      }
      breakdown.push({ type: "utility", name: "Guided Generations (user)", role: "user" });
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
function populateLumiaLoomContext(
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
  const councilSettings = getCouncilSettings(userId);

  // Batch-load full Lumia items for council members (single query)
  const memberItemIds = councilSettings.members.map((m: any) => m.itemId);
  const memberItemsMap = memberItemIds.length > 0
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
    if (_allLumiaItems === null) _allLumiaItems = packsSvc.getAllLumiaItems(userId);
    return _allLumiaItems;
  };

  // ---- Inject into env.extra ----
  macroEnv.extra.lumia = {
    selectedDefinition: selectedDef,
    selectedBehaviors,
    selectedPersonalities,
    chimeraMode,
    quirks: lumiaQuirks,
    quirksEnabled: lumiaQuirksEnabled,
    get allItems() { return allItemsLoader(); },
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

/**
 * Collect all WorldBookEntry[] from character extensions + persona attached book.
 */
function collectWorldInfoEntries(userId: string, character: Character, persona: Persona | null, globalWorldBookIds?: string[]): import("../types/world-book").WorldBookEntry[] {
  return collectWorldInfoSources(userId, character, persona, globalWorldBookIds).entries;
}

function collectWorldInfoSources(
  userId: string,
  character: Character,
  persona: Persona | null,
  globalWorldBookIds?: string[],
): { entries: import("../types/world-book").WorldBookEntry[]; worldBookIds: string[] } {
  const entries: import("../types/world-book").WorldBookEntry[] = [];
  const worldBookIds: string[] = [];

  // Character's attached world book (stored in extensions)
  const charBookId = character.extensions?.world_book_id as string | undefined;
  if (charBookId) {
    worldBookIds.push(charBookId);
    entries.push(...worldBooksSvc.listEntries(userId, charBookId));
  }

  // Persona's attached world book
  if (persona?.attached_world_book_id) {
    worldBookIds.push(persona.attached_world_book_id);
    entries.push(...worldBooksSvc.listEntries(userId, persona.attached_world_book_id));
  }

  // Global world books (user-wide, always active regardless of character/persona)
  if (globalWorldBookIds?.length) {
    const seen = new Set(worldBookIds);
    for (const gId of globalWorldBookIds) {
      if (seen.has(gId)) continue; // avoid duplicating a book already attached via character/persona
      seen.add(gId);
      worldBookIds.push(gId);
      entries.push(...worldBooksSvc.listEntries(userId, gId));
    }
  }

  return {
    entries,
    worldBookIds: Array.from(new Set(worldBookIds)),
  };
}

export interface VectorActivatedEntry {
  entry: import("../types/world-book").WorldBookEntry;
  score: number;
}

export async function collectVectorActivatedWorldInfo(
  userId: string,
  worldBookIds: string[],
  entries: import("../types/world-book").WorldBookEntry[],
  messages: Message[],
): Promise<VectorActivatedEntry[]> {
  if (worldBookIds.length === 0) return [];

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_world_books) return [];

  const contextSize = Math.max(1, cfg.preferred_context_size || 3);
  const queryMessages = messages.filter(m => !(m.extra?.hidden) && m.content.trim().length > 0).slice(-contextSize);
  const queryText = queryMessages.map((m) => `[${m.name}]: ${m.content}`).join("\n").trim();
  if (!queryText) return [];

  try {
    // Embed query once (or hit cache), regardless of how many world books
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText]);
    if (!queryVector || queryVector.length === 0) return [];

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const out: VectorActivatedEntry[] = [];
    const scored: Array<{ entry: import("../types/world-book").WorldBookEntry; score: number }> = [];
    const seen = new Set<string>();
    const topK = Math.max(1, cfg.retrieval_top_k || 4);

    // Search all world books in parallel using the pre-computed vector
    const searchResults = await Promise.allSettled(
      worldBookIds.map((worldBookId) =>
        embeddingsSvc.searchWorldBookEntriesWithVector(userId, worldBookId, queryVector, topK)
      )
    );

    for (const result of searchResults) {
      if (result.status === "rejected") {
        console.warn("[WI] Vector search failed:", result.reason);
        continue;
      }
      for (const hit of result.value) {
        const entry = byId.get(hit.entry_id);
        if (!entry) continue;
        if (seen.has(entry.id)) continue;
        if (entry.disabled || !entry.content.trim()) continue;
        scored.push({ entry, score: hit.score });
        seen.add(entry.id);
      }
    }

    // Filter by similarity threshold 
    if (cfg.similarity_threshold > 0) {
      const cutoff = cfg.similarity_threshold;
      scored.splice(0, scored.length, ...scored.filter((s) => s.score <= cutoff));
    }

    scored.sort((a, b) => a.score - b.score);

    let cap = topK;
    if (cfg.hybrid_weight_mode === "keyword_first") {
      cap = Math.max(1, Math.ceil(topK / 2));
    } else if (cfg.hybrid_weight_mode === "vector_first") {
      cap = Math.min(24, topK * 2);
    }

    for (const item of scored.slice(0, cap)) {
      out.push({ entry: item.entry, score: item.score });
    }

    return out;
  } catch (err) {
    console.warn("[prompt] Vector activated world info retrieval failed:", err);
    return [];
  }
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
async function collectChatVectorMemory(
  userId: string,
  chatId: string,
  messages: Message[],
): Promise<string[]> {
  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) return [];

  const params = embeddingsSvc.getChatMemoryParams(cfg.chat_memory_mode);
  const contextSize = Math.max(1, cfg.preferred_context_size || 3);
  const visibleMessages = messages.filter(m => !(m.extra?.hidden) && m.content.trim().length > 0);
  const queryMessages = visibleMessages.slice(-contextSize);
  const queryText = queryMessages.map((m) => `[${m.name}]: ${m.content}`).join("\n").trim();
  if (!queryText) return [];

  try {
    const queryHash = hashQueryText(queryText);
    const cachedVector = await getQueryVectorFromCache(chatId, queryHash);

    let queryVector: number[];

    if (cachedVector) {
      queryVector = cachedVector;
    } else {
      const chunks = chatsSvc.getChatChunks(userId, chatId);
      const pendingChunks = chunks.filter(c => !c.vectorized_at);

      if (pendingChunks.length > 0) {
        // Chunks not ready - use SQLite fallback
        return getRecentRelevantChunks(userId, chatId, queryText, cfg.retrieval_top_k);
      }

      // Generate query vector and cache it
      const [vector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText]);
      if (!vector || vector.length === 0) return [];

      queryVector = vector;
      await cacheQueryVector(chatId, queryHash, queryText, queryVector);
    }

    // Build exclusion set: exclude recent messages within the exclusion window
    const excludeIds = new Set<string>();
    const exclusionWindow = params.exclusionWindow;
    const recentMessages = visibleMessages.slice(-exclusionWindow);
    for (const m of recentMessages) {
      excludeIds.add(m.id);
    }

    const limit = cfg.retrieval_top_k;
    const hits = await embeddingsSvc.searchChatChunks(userId, chatId, queryVector, excludeIds, limit);

    // Apply similarity threshold filtering
    let filteredHits = hits;
    if (cfg.similarity_threshold > 0) {
      filteredHits = hits.filter(h => h.score <= cfg.similarity_threshold);
    }

    if (filteredHits.length > 0) {
      console.info(`[chat-memory] Retrieved ${filteredHits.length} memory chunk(s) from past conversation`);
    }

    return filteredHits.map(h => h.content);
  } catch (err) {
    console.warn("[prompt] Chat memory retrieval failed:", err);
    return [];
  }
}

/**
 * Hash query text for cache lookup.
 */
function hashQueryText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Get cached query vector from SQLite.
 */
async function getQueryVectorFromCache(chatId: string, queryHash: string): Promise<number[] | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = getDb()
    .query("SELECT vector_json, expires_at FROM query_vector_cache WHERE chat_id = ? AND query_hash = ? AND expires_at > ?")
    .get(chatId, queryHash, now) as any;

  if (!row) return null;

  try {
    const vector = JSON.parse(row.vector_json);
    // Update hit count and last used
    getDb()
      .query("UPDATE query_vector_cache SET hit_count = hit_count + 1, last_used_at = ? WHERE chat_id = ? AND query_hash = ?")
      .run(now, chatId, queryHash);
    return vector;
  } catch {
    return null;
  }
}

/**
 * Cache a query vector in SQLite.
 */
async function cacheQueryVector(chatId: string, queryHash: string, queryText: string, vector: number[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300; // 5 minutes

  getDb()
    .query(
      `INSERT INTO query_vector_cache (id, chat_id, query_hash, query_text, vector_json, hit_count, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(chat_id, query_hash) DO UPDATE SET
         vector_json = excluded.vector_json,
         last_used_at = excluded.last_used_at,
         expires_at = excluded.expires_at`
    )
    .run(crypto.randomUUID(), chatId, queryHash, queryText, JSON.stringify(vector), now, now, expiresAt);
}

/**
 * Fallback retrieval using SQLite when vectors aren't ready.
 * Returns recent chunks that might be relevant based on recency.
 */
function getRecentRelevantChunks(userId: string, chatId: string, queryText: string, limit: number): string[] {
  const chunks = chatsSvc.getChatChunks(userId, chatId);

  // Simple recency-based retrieval
  const sorted = chunks.sort((a, b) => b.created_at - a.created_at);
  const topChunks = sorted.slice(0, limit);

  return topChunks.map(c => c.content);
}

function injectEntryIntoCache(cache: WorldInfoCache, entry: import("../types/world-book").WorldBookEntry): void {
  const content = entry.content;
  if (!content) return;
  const role: "system" | "user" | "assistant" =
    entry.role === "user" || entry.role === "assistant" ? entry.role : "system";

  switch (entry.position) {
    case 0:
      cache.before.push({ content, role });
      break;
    case 1:
      cache.after.push({ content, role });
      break;
    case 2:
      cache.anBefore.push({ content, role });
      break;
    case 3:
      cache.anAfter.push({ content, role });
      break;
    case 4:
      cache.depth.push({ content, role, depth: entry.depth });
      break;
    case 5:
      cache.emBefore.push({ content, role });
      break;
    case 6:
      cache.emAfter.push({ content, role });
      break;
    default:
      cache.before.push({ content, role });
      break;
  }
}

function injectWorldInfoAt(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  entries: Array<{ content: string; role: "system" | "user" | "assistant" }>,
  insertAt: number,
  name: string,
): number {
  if (entries.length === 0) return 0;
  let idx = Math.max(0, Math.min(insertAt, result.length));
  for (const entry of entries) {
    result.splice(idx, 0, { role: entry.role, content: entry.content });
    breakdown.push({ type: "world_info", name, role: entry.role, content: entry.content });
    idx++;
  }
  return entries.length;
}

function applyAppendBlock(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  append: PendingAppend,
): void {
  let roleCount = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === append.baseRole) {
      if (roleCount === append.depth) {
        if (typeof result[i].content === "string") {
          result[i] = { ...result[i], content: result[i].content + "\n" + append.content };
        } else {
          // Multipart: append to the text part
          const parts = [...result[i].content as import("../llm/types").LlmMessagePart[]];
          const textIdx = parts.findIndex((p) => p.type === "text");
          if (textIdx >= 0) {
            const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
            parts[textIdx] = { type: "text", text: tp.text + "\n" + append.content };
          } else {
            parts.unshift({ type: "text", text: append.content });
          }
          result[i] = { ...result[i], content: parts };
        }
        breakdown.push({
          type: "append",
          name: `${append.blockName} → ${append.baseRole}@${append.depth}`,
          role: append.baseRole,
          content: append.content,
          blockId: append.blockId,
        });
        return;
      }
      roleCount++;
    }
  }
  // Target not found — skip silently
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
  reasoningSettings: { prefix?: string; suffix?: string; keepInHistory?: number },
): void {
  const keepInHistory = reasoningSettings.keepInHistory ?? -1;
  if (keepInHistory === -1) return;

  const rawPrefix = (reasoningSettings.prefix ?? "<think>\n").replace(/^\n+|\n+$/g, "");
  const rawSuffix = (reasoningSettings.suffix ?? "\n</think>").replace(/^\n+|\n+$/g, "");

  const escapedPrefix = rawPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSuffix = rawSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s*${escapedPrefix}[\\s\\S]*?${escapedSuffix}\\s*`, "g");

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
  "loom_sum", "loom_if", "loom_else", "loom_endif",
  "lumia_ooc", "lumiaooc", "lumio_ooc", "lumioooc",
  "loom_state", "loom_memory", "loom_context", "loom_inject", "loom_var", "loom_set", "loom_get",
  "loom_record", "loomrecord", "loom_ledger", "loomledger",
];

// Pre-compiled regexes for loom tags (paired + self-closing)
const LOOM_TAG_REGEXES = LOOM_TAGS.map((tag) => ({
  paired: new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"),
  self: new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>`, "gi"),
}));

// HTML formatting tags to strip (preserves inner text)
const HTML_FORMAT_TAGS = ["span", "b", "i", "u", "em", "strong", "s", "strike", "sub", "sup", "mark", "small", "big"];
const HTML_TAG_REGEXES = HTML_FORMAT_TAGS.map((tag) => ({
  open: new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"),
  close: new RegExp(`</${tag}>`, "gi"),
}));

const MAX_FILTER_ITERATIONS = 20;

/** Remove <details>...</details> blocks entirely (handles nesting). */
function stripDetailsBlocks(content: string): string {
  let result = content;
  let prev: string;
  let iter = 0;
  do {
    if (++iter > MAX_FILTER_ITERATIONS) break;
    prev = result;
    result = result.replace(/<details(?:\s[^>]*)?>([\s\S]*?)<\/details>/gi, "");
  } while (result !== prev);
  return result;
}

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

/** Remove all loom-related tags and their content. */
function stripLoomTags(content: string): string {
  let result = content;
  for (const { paired, self } of LOOM_TAG_REGEXES) {
    paired.lastIndex = 0;
    self.lastIndex = 0;
    result = result.replace(paired, "");
    result = result.replace(self, "");
  }
  return result;
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

/** Strip HTML formatting tags (preserving inner text) + div handling. */
function stripHtmlFormattingTags(content: string): string {
  let result = content;

  // Handle divs: extract codeblock containers, then strip remaining divs
  let prev: string;
  let iter = 0;
  do {
    if (++iter > MAX_FILTER_ITERATIONS) break;
    prev = result;
    result = result.replace(
      /<div[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>(\s*```[\s\S]*?```\s*)<\/div>/gi,
      "$1",
    );
    result = result.replace(/<div(?:\s[^>]*)?>([\s\S]*?)<\/div>/gi, "");
  } while (result !== prev);
  result = result.replace(/<\/div>/gi, "");

  // Strip formatting tags (preserve inner text)
  for (const { open, close } of HTML_TAG_REGEXES) {
    open.lastIndex = 0;
    close.lastIndex = 0;
    result = result.replace(open, "");
    result = result.replace(close, "");
  }

  return result;
}

/** Strip <font> tags (preserving inner text). */
function stripFontTags(content: string): string {
  return content.replace(/<font(?:\s[^>]*)?>/gi, "").replace(/<\/font>/gi, "");
}

/** Collapse 3+ consecutive newlines to 2 (standard paragraph break). */
function collapseExcessiveNewlines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
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

    // HTML tag stripping (always strip mode — no keepOnly for HTML)
    if (htmlEnabled && depthFromEnd >= htmlKeepDepth) {
      filtered = stripHtmlFormattingTags(filtered);
    }
    if (htmlEnabled && fontEnabled && depthFromEnd >= fontKeepDepth) {
      filtered = stripFontTags(filtered);
    }

    // Details blocks
    if (detailsEnabled && depthFromEnd >= detailsKeepDepth) {
      if (detailsKeepOnly) {
        filtered = keepOnlyDetailsBlocks(filtered);
      } else {
        filtered = stripDetailsBlocks(filtered);
      }
    }

    // Loom tags
    if (loomEnabled && depthFromEnd >= loomKeepDepth) {
      if (loomKeepOnly) {
        filtered = keepOnlyLoomTags(filtered);
      } else {
        filtered = stripLoomTags(filtered);
      }
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
 * Handles squashSystemMessages, useSystemPrompt, namesBehavior, and assistantPrefill
 * in a single O(n) pass (where possible).
 */
function applyCompletionSettings(
  result: LlmMessage[],
  settings: CompletionSettings,
  character: Character,
  persona: Persona | null,
  generationType: GenerationType,
): void {
  // Single forward pass: squash consecutive system messages + convert system→user
  // + apply namesBehavior
  const squash = settings.squashSystemMessages;
  const noSystem = settings.useSystemPrompt === false;
  const namesBehavior = settings.namesBehavior ?? 0;

  let i = 0;
  while (i < result.length) {
    const msg = result[i];

    // Squash: merge consecutive system messages
    if (squash && msg.role === "system" && i > 0 && result[i - 1].role === "system") {
      result[i - 1] = { ...result[i - 1], content: result[i - 1].content + "\n\n" + msg.content };
      result.splice(i, 1);
      continue; // re-check same index
    }

    // useSystemPrompt false: convert system → user
    if (noSystem && msg.role === "system") {
      result[i] = { ...msg, role: "user" };
    }

    // namesBehavior: 1 = add name field, 2 = prepend "Name: " to content
    if (namesBehavior === 1 && (msg.role === "user" || msg.role === "assistant")) {
      const name = msg.role === "user" ? (persona?.name ?? "User") : character.name;
      result[i] = { ...result[i], name };
    } else if (namesBehavior === 2 && (msg.role === "user" || msg.role === "assistant")) {
      const name = msg.role === "user" ? (persona?.name ?? "User") : character.name;
      if (typeof result[i].content === "string") {
        result[i] = { ...result[i], content: `${name}: ${result[i].content}` };
      } else {
        const parts = [...result[i].content as import("../llm/types").LlmMessagePart[]];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          const tp = parts[textIdx] as import("../llm/types").LlmTextPart;
          parts[textIdx] = { type: "text", text: `${name}: ${tp.text}` };
        }
        result[i] = { ...result[i], content: parts };
      }
    }

    i++;
  }

  // NOTE: assistantPrefill is now folded into the user nudge by assemblePrompt().
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
  reasoningSettings?: { apiReasoning?: boolean; reasoningEffort?: string } | null,
  providerName?: string | null,
  modelName?: string | null,
): Record<string, any> {
  const params: Record<string, any> = {};

  // Sampler overrides — when enabled, apply user values (or defaults for core params).
  // A value of 0 on sampling params means "exclude from request", allowing users to
  // avoid provider conflicts (e.g. Claude rejects requests with both temperature and top_p).
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
    if (Array.isArray(advancedSettings.customStopStrings) && advancedSettings.customStopStrings.length > 0) {
      params.stop = advancedSettings.customStopStrings;
    }
    if (typeof advancedSettings.seed === "number" && advancedSettings.seed >= 0) {
      params.seed = advancedSettings.seed;
    }
  }

  // API-level reasoning: inject provider-specific params when enabled.
  // Placed before custom body so custom body can override with more specific config.
  if (reasoningSettings?.apiReasoning && providerName) {
    const effort = reasoningSettings.reasoningEffort || "auto";
    if (effort !== "auto") {
      injectReasoningParams(params, providerName, effort, modelName || undefined);
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

  return params;
}

/**
 * Inject provider-specific reasoning/thinking parameters based on the
 * user's reasoning effort setting. Does NOT override if the parameter
 * is already set (e.g. by a prior custom body or explicit override).
 */
export function injectReasoningParams(params: Record<string, any>, providerName: string, effort: string, model?: string): void {
  if (providerName === "anthropic") {
    if (!params.thinking) {
      // Claude 4.6 models support adaptive thinking (recommended over manual budget)
      const isAdaptiveModel = model && /claude-(opus|sonnet)-4-6/i.test(model);
      if (isAdaptiveModel) {
        // Adaptive thinking: Claude decides when/how much to think
        params.thinking = { type: "adaptive" };
        // Map effort to output_config.effort — "max" is gated to Opus 4.6 only
        const isOpus46 = model && /claude-opus-4-6/i.test(model);
        let mappedEffort = effort;
        if (effort === "max" && !isOpus46) mappedEffort = "high";
        params.output_config = { effort: mappedEffort };
      } else {
        // Legacy extended thinking for older Claude models
        const budgetMap: Record<string, number> = { low: 2048, medium: 8192, high: 16384 };
        const budget = budgetMap[effort] || 8192;
        params.thinking = { type: "enabled", budget_tokens: budget };
      }
    }
  } else if (providerName === "google") {
    // Google Gemini: thinkingConfig with thinkingLevel (3.x) or thinkingBudget (2.5.x)
    // Use thinkingLevel as it covers both model generations.
    if (!params.thinkingConfig) {
      const levelMap: Record<string, string> = { low: "low", medium: "medium", high: "high" };
      params.thinkingConfig = { thinkingLevel: levelMap[effort] || "medium" };
    }
  } else {
    // OpenAI-compatible providers (OpenAI, OpenRouter, NanoGPT, Moonshot, Z.AI, etc.)
    // reasoning: { effort } is the standard format for reasoning-capable models.
    if (!params.reasoning) {
      params.reasoning = { effort };
    }
  }
}

/**
 * One-liner impersonation: skip all preset blocks, include only chat history
 * and the impersonation prompt from preset behaviors. Optionally includes the
 * assistantImpersonation prefill nudge.
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
  reasoningSettings?: { apiReasoning?: boolean; reasoningEffort?: string } | null,
): Promise<AssemblyResult> {
  const result: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];

  // Chat history
  let messageCount = 0;
  const historyParts: string[] = [];
  for (const msg of messages) {
    if (msg.extra?.hidden === true) continue;
    const role: "user" | "assistant" = msg.is_user ? "user" : "assistant";
    const resolvedContent = (await evaluate(msg.content, macroEnv, registry)).text;
    result.push({ role, content: resolvedContent });
    historyParts.push(resolvedContent);
    messageCount++;
  }
  breakdown.push({ type: "chat_history", name: "Chat History", messageCount, content: historyParts.join("\n") });

  // Impersonation prompt
  const prompt = promptBehavior.impersonationPrompt;
  if (prompt) {
    const resolved = (await evaluate(prompt, macroEnv, registry)).text;
    if (resolved) {
      result.push({ role: "system", content: resolved });
      breakdown.push({ type: "utility", name: "Impersonation Prompt", role: "system", content: resolved });
    }
  }

  // assistantImpersonation prefill nudge
  const csPrefill = completionSettings.assistantImpersonation || completionSettings.assistantPrefill;
  if (csPrefill) {
    const resolvedPrefill = (await evaluate(csPrefill, macroEnv, registry)).text;
    if (resolvedPrefill) {
      const nudgeContent = `Begin your reply with: ${resolvedPrefill}`;
      result.push({ role: "user", content: nudgeContent });
      breakdown.push({ type: "utility", name: "User Nudge", role: "user", content: nudgeContent });
    }
  }

  // Build parameters from sampler overrides + reasoning settings
  const parameters = buildParameters(samplerOverrides, preset, reasoningSettings, connection?.provider, connection?.model);

  return { messages: result, breakdown, parameters };
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
): Promise<AssemblyResult> {
  const llmMessages: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];

  // Initialize macros for legacy path too
  initMacros();
  let macroEnv: MacroEnv | null = null;
  if (character && chat) {
    macroEnv = buildEnv({
      character: character as Character,
      persona: persona ?? null,
      chat: chat as Chat,
      messages,
      generationType,
      connection: connection ?? null,
    });
    // Populate reasoning macros
    if (userId) {
      const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
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

  // Build a system prompt from the character card
  const systemParts: string[] = [];
  if (character?.description) systemParts.push(character.description);
  if (character?.personality) systemParts.push(`Personality: ${character.personality}`);
  if (character?.scenario) systemParts.push(`Scenario: ${character.scenario}`);
  if (persona?.description) systemParts.push(`[User persona: ${persona.description}]`);

  if (systemParts.length > 0) {
    const systemContent = await resolveMacros(systemParts.join("\n\n"));
    llmMessages.push({ role: "system", content: systemContent });
    breakdown.push({ type: "block", name: "Character Card (legacy)", role: "system", content: systemContent });
  }

  // Add dialogue examples if present
  if (character?.mes_example) {
    const examples = character.mes_example.trim();
    if (examples) {
      const resolvedExamples = await resolveMacros(`Example dialogue:\n${examples}`);
      llmMessages.push({ role: "system", content: resolvedExamples });
      breakdown.push({ type: "block", name: "Dialogue Examples (legacy)", role: "system", content: resolvedExamples });
    }
  }

  if (userId && chat) {
    const chatVectorMemories = await collectChatVectorMemory(userId, chat.id, messages);
    if (chatVectorMemories.length > 0) {
      const memoryContent = "Past Memories (for context only):\n" + chatVectorMemories.join("\n\n");
      llmMessages.push({ role: "system", content: memoryContent });
      breakdown.push({ type: "long_term_memory", name: "Long-Term Memory", role: "system", content: memoryContent });
    }
  }

  // Chat history — evaluate macros in each message
  // Skip messages marked as hidden drafts (extra.hidden === true)
  const legacyFirstChatIdx = llmMessages.length;
  let legacyHistoryCount = 0;
  const legacyHistoryParts: string[] = [];
  for (const m of messages) {
    if (m.extra?.hidden === true) continue;
    const resolved = await resolveMacros(m.content);
    legacyHistoryParts.push(resolved);
    const attachments = Array.isArray(m.extra?.attachments) ? m.extra.attachments : [];
    if (attachments.length > 0) {
      const parts: import("../llm/types").LlmMessagePart[] = [{ type: "text", text: resolved }];
      for (const att of attachments) {
        if (!att.image_id || !userId) continue;
        const b64 = resolveAttachmentBase64(userId, att.image_id as string);
        if (!b64) continue;
        if (att.type === "image") {
          parts.push({ type: "image", data: b64, mime_type: att.mime_type });
        } else if (att.type === "audio") {
          parts.push({ type: "audio", data: b64, mime_type: att.mime_type });
        }
      }
      llmMessages.push({
        role: (m.is_user ? "user" : "assistant") as LlmMessage["role"],
        content: parts,
      });
    } else {
      llmMessages.push({
        role: (m.is_user ? "user" : "assistant") as LlmMessage["role"],
        content: resolved,
      });
    }
    legacyHistoryCount++;
  }
  breakdown.push({ type: "chat_history", name: "Chat History (legacy)", messageCount: legacyHistoryCount, content: legacyHistoryParts.join("\n") });

  // Strip reasoning from older chat history messages based on keepInHistory
  let reasoningVal: { apiReasoning?: boolean; reasoningEffort?: string } | null = null;
  if (userId) {
    const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
    if (reasoningSetting?.value) {
      stripReasoningFromChatHistory(llmMessages, legacyFirstChatIdx, legacyHistoryCount, reasoningSetting.value);
      reasoningVal = reasoningSetting.value;
    }

    // Apply context filters (details blocks, loom tags, HTML tags)
    const contextFiltersSetting = settingsSvc.getSetting(userId, "contextFilters");
    if (contextFiltersSetting?.value) {
      applyContextFilters(llmMessages, legacyFirstChatIdx, legacyHistoryCount, contextFiltersSetting.value as ContextFilters);
    }
  }

  // Build parameters with reasoning settings so API-level reasoning is injected
  const parameters = buildParameters(null, null, reasoningVal, connection?.provider, connection?.model);

  return { messages: llmMessages, breakdown, parameters };
}
