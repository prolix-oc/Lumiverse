import { buildEnv, initMacros, mergeDynamicMacros, resolveGroupCharacterNames, resolvePersonaPronouns } from "../macros";
import type { MacroEnv } from "../macros";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { getEffectiveCharacterName, makeAssistantCharacter } from "../types/character";
import type { Chat } from "../types/chat";
import { isTemporaryChatMetadata } from "../types/chat";
import type { RegexPlacement, RegexScript } from "../types/regex-script";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as personasSvc from "./personas.service";
import { resolvePersonaForChatMacros } from "./persona-addon-states";
import { populateLumiaLoomContext } from "./prompt-assembly.service";
import { applyRegexScripts } from "./regex-scripts.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

initMacros();

export interface DisplayRegexContext {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  is_user: boolean;
  depth: number;
  message_id?: string;
  message_index?: number;
  role?: "user" | "assistant" | "system";
}

export interface ApplyDisplayRegexInput {
  content: string;
  scripts: RegexScript[];
  context: DisplayRegexContext;
  userId: string;
  resolvedFindPatterns?: Map<string, string>;
  resolvedReplacements?: Map<string, string>;
  dynamicMacros?: Record<string, string>;
  signal?: AbortSignal;
}

function buildEnvFromContext(userId: string, ctx: DisplayRegexContext): MacroEnv | undefined {
  if (ctx.chat_id) {
    const chat = chatsSvc.getChat(userId, ctx.chat_id);
    if (chat) {
      const messages = chatsSvc.getMessages(userId, ctx.chat_id);
      const character = chat.character_id
        ? charactersSvc.getCharacter(userId, chat.character_id)
        : makeAssistantCharacter();
      if (character) {
        const persona = isTemporaryChatMetadata(chat.metadata)
          ? null
          : resolvePersonaForChatMacros(
              userId,
              personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
              chat.metadata,
            );
        const connection = connectionsSvc.getDefaultConnection(userId);
        const groupCharacterNames = resolveGroupCharacterNames(chat, (cid) => {
          const c = charactersSvc.getCharacter(userId, cid);
          return c ? getEffectiveCharacterName(c) : undefined;
        });
        const isGroup = !!chat.metadata?.group;
        const env = buildEnv({
          character,
          persona,
          chat,
          messages,
          generationType: "normal",
          connection,
          groupCharacterNames,
          targetCharacterName: isGroup ? getEffectiveCharacterName(character) : undefined,
        });
        populateLumiaLoomContext(env, userId, chat);
        return env;
      }
    }
  }

  if (ctx.character_id) {
    const character = charactersSvc.getCharacter(userId, ctx.character_id);
    if (character) {
      // No chat context here, so there are no per-chat add-on bindings to apply.
      const persona = resolvePersonaForChatMacros(
        userId,
        personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
        null,
      );
      const connection = connectionsSvc.getDefaultConnection(userId);
      const chat: Chat = {
        id: "",
        character_id: character.id,
        name: "",
        metadata: {},
        created_at: 0,
        updated_at: 0,
      };
      const env = buildEnv({
        character,
        persona,
        chat,
        messages: [],
        generationType: "normal",
        connection,
      });
      populateLumiaLoomContext(env, userId, chat);
      return env;
    }
  }

  const persona = resolvePersonaForChatMacros(
    userId,
    personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
    null,
  );
  const personaPronouns = resolvePersonaPronouns(persona);
  const connection = connectionsSvc.getDefaultConnection(userId);
  return {
    commit: true,
    names: {
      user: persona?.name || "User",
      char: "",
      group: "",
      groupNotMuted: "",
      notChar: persona?.name || "User",
      charGroupFocused: "",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: persona?.is_narrator ? "yes" : "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      persona: persona?.description || "",
      personaSubjectivePronoun: personaPronouns.subjective,
      personaObjectivePronoun: personaPronouns.objective,
      personaPossessivePronoun: personaPronouns.possessive,
      mesExamples: "",
      mesExamplesRaw: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      depthPrompt: "",
      creatorNotes: "",
      version: "",
      creator: "",
      firstMessage: "",
    },
    chat: {
      id: "",
      messageCount: 0,
      lastMessage: "",
      lastMessageName: "",
      lastUserMessage: "",
      lastCharMessage: "",
      lastMessageId: -1,
      firstIncludedMessageId: -1,
      lastSwipeId: 0,
      currentSwipeId: 0,
    },
    system: {
      model: connection?.model || "",
      maxPrompt: 0,
      maxContext: 0,
      maxResponse: 0,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros: {},
    extra: {},
  };
}

export interface ApplyDisplayRegexResult {
  result: string;
  touchedVars: ReadonlySet<string>;
  cacheable: boolean;
}

type DisplayVarEnv = { variables: { local: Map<string, unknown>; chat: Map<string, unknown>; global: Map<string, unknown> } } | null | undefined;

const DISPLAY_REGEX_CACHE = new Map<string, { result: string; touched: ReadonlyArray<readonly [string, string]> }>();
const DISPLAY_REGEX_CACHE_MAX = 1000;

function varStateForKey(env: DisplayVarEnv, name: string): string {
  if (!env) return "";
  const v = env.variables;
  const sep = name.indexOf(":");
  if (sep > 0) {
    const scope = name.slice(0, sep);
    const bare = name.slice(sep + 1);
    const map = scope === "local" ? v.local : scope === "chat" ? v.chat : scope === "global" ? v.global : null;
    if (map) return String(map.get(bare) ?? "");
  }
  return `${v.local.get(name) ?? ""}${v.chat.get(name) ?? ""}${v.global.get(name) ?? ""}`;
}

function displayRegexCacheKey(
  chatId: string | undefined,
  content: string,
  placement: RegexPlacement,
  depth: number | undefined,
  scripts: ReadonlyArray<{ id: string; updated_at: number }>,
  dynamicMacros: Record<string, string> | undefined,
  resolvedFind?: ReadonlyMap<string, string>,
  resolvedReplace?: ReadonlyMap<string, string>,
): string {
  const SEP = "\x00";
  let k = (chatId ?? "") + SEP + content + SEP + placement + SEP + (depth ?? "") + SEP;
  for (const s of scripts) k += s.id + ":" + s.updated_at + ";";
  if (dynamicMacros) { k += SEP + "D"; for (const a of Object.keys(dynamicMacros).sort()) k += a + "=" + dynamicMacros[a] + ";"; }
  if (resolvedFind) { k += SEP + "F"; for (const [a, b] of resolvedFind) k += a + "=" + b + ";"; }
  if (resolvedReplace) { k += SEP + "R"; for (const [a, b] of resolvedReplace) k += a + "=" + b + ";"; }
  return k;
}

export function resetDisplayRegexCache(): void {
  DISPLAY_REGEX_CACHE.clear();
}

export function invalidateDisplayRegexCacheForChat(chatId: string): void {
  if (!chatId) { DISPLAY_REGEX_CACHE.clear(); return; }
  const prefix = chatId + "\x00";
  for (const key of DISPLAY_REGEX_CACHE.keys()) {
    if (key.startsWith(prefix)) DISPLAY_REGEX_CACHE.delete(key);
  }
}

for (const __ev of [
  EventType.CHAT_CHANGED, EventType.CHAT_SWITCHED, EventType.CHAT_DELETED,
  EventType.MESSAGE_SENT, EventType.MESSAGE_EDITED, EventType.MESSAGE_DELETED, EventType.MESSAGE_SWIPED,
  EventType.GENERATION_ENDED, EventType.GENERATION_STOPPED,
]) {
  eventBus.on(__ev, (msg) => {
    const p = (msg as { payload?: { chatId?: string; chat_id?: string; chat?: { id?: string } } }).payload;
    const cid = p?.chatId ?? p?.chat_id ?? p?.chat?.id;
    if (cid) invalidateDisplayRegexCacheForChat(cid);
    else DISPLAY_REGEX_CACHE.clear();
  });
}

for (const __ev of [
  EventType.CHARACTER_EDITED, EventType.PERSONA_CHANGED,
  EventType.REGEX_SCRIPT_CHANGED, EventType.REGEX_SCRIPT_DELETED,
]) {
  eventBus.on(__ev, () => { DISPLAY_REGEX_CACHE.clear(); });
}

export async function applyDisplayRegex(input: ApplyDisplayRegexInput): Promise<ApplyDisplayRegexResult> {
  const placement: RegexPlacement = input.context.is_user ? "user_input" : "ai_output";

  let content = input.content;
  if (
    messageContentProcessorChain.count > 0
    && input.context.chat_id
    && content.length > 0
  ) {
    try {
      const pre = await messageContentProcessorChain.run(
        {
          chatId: input.context.chat_id,
          content,
          origin: "render",
          userId: input.userId,
          ...(input.context.message_id ? { messageId: input.context.message_id } : {}),
          extra: {
            ...(typeof input.context.message_index === "number"
              ? { messageIndex: input.context.message_index }
              : {}),
            ...(input.context.role
              ? { role: input.context.role, is_user: input.context.role === "user" }
              : {}),
          },
        },
        input.userId,
        input.signal,
      );
      if (typeof pre.content === "string") content = pre.content;
    } catch {
      // Render-MCP failure should not block regex application; fall through with the raw content.
    }
  }

  const env = buildEnvFromContext(input.userId, input.context);
  const dyn: Record<string, string> = { ...(input.dynamicMacros ?? {}) };
  if (env) {
    if (input.context.role && dyn.role === undefined) {
      dyn.role = input.context.role;
    }
    const lastMsgId = (env.chat as { lastMessageId?: number } | undefined)?.lastMessageId;
    if (typeof lastMsgId === "number" && typeof input.context.depth === "number") {
      dyn.chat_index = String(lastMsgId - input.context.depth);
    }
    if (Object.keys(dyn).length > 0) {
      mergeDynamicMacros(env, dyn);
    }
  }
  const noCache = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.LUMIVERSE_DISPLAY_REGEX_NO_CACHE === "1";
  const cacheKey = displayRegexCacheKey(input.context.chat_id, content, placement, input.context.depth, input.scripts, dyn, input.resolvedFindPatterns, input.resolvedReplacements);
  if (!noCache) {
    const cached = DISPLAY_REGEX_CACHE.get(cacheKey);
    if (cached && (env ? cached.touched.every(([n, val]) => varStateForKey(env, n) === val) : cached.touched.length === 0)) {
      return { result: cached.result, touchedVars: new Set(cached.touched.map(([n]) => n)), cacheable: true };
    }
  }

  const fingerprint = { touchedVars: new Set<string>(), cacheable: true };
  const result = await applyRegexScripts(
    content,
    input.scripts,
    placement,
    input.context.depth,
    env,
    {
      resolvedFindPatterns: input.resolvedFindPatterns,
      resolvedReplacements: input.resolvedReplacements,
    },
    { source: "display_backend", outFingerprint: fingerprint },
  );
  if (!noCache && fingerprint.cacheable) {
    DISPLAY_REGEX_CACHE.set(cacheKey, {
      result,
      touched: [...fingerprint.touchedVars].map((n) => [n, varStateForKey(env, n)] as const),
    });
    if (DISPLAY_REGEX_CACHE.size > DISPLAY_REGEX_CACHE_MAX) {
      const first = DISPLAY_REGEX_CACHE.keys().next().value;
      if (first !== undefined) DISPLAY_REGEX_CACHE.delete(first);
    }
  }
  return {
    result,
    touchedVars: fingerprint.touchedVars,
    cacheable: fingerprint.cacheable,
  };
}
