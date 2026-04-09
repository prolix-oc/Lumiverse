import type { Character } from "../types/character";
import type { Persona } from "../types/persona";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { ConnectionProfile } from "../types/connection-profile";
import type { GenerationType } from "../llm/types";
import type { MacroEnv, MacroHandler, MacroDefinition } from "./types";

export interface BuildEnvContext {
  character: Character;
  persona: Persona | null;
  chat: Chat;
  messages: Message[];
  generationType: GenerationType;
  connection?: ConnectionProfile | null;
  userId?: string;
  dynamicMacros?: Record<string, string | MacroHandler | MacroDefinition>;
  /** Pre-resolved group character names (all members). Used for {{group}} macro. */
  groupCharacterNames?: string[];
  /** Pre-resolved non-muted group character names. Used for {{groupNotMuted}} macro. Falls back to groupCharacterNames if not provided. */
  groupNotMutedNames?: string[];
  /** The target character ID for group chats (the character whose turn it is). */
  targetCharacterId?: string;
  /** Pre-resolved name of the target/focused character. Falls back to character.name if targetCharacterId is set. */
  targetCharacterName?: string;
}

export function buildEnv(ctx: BuildEnvContext): MacroEnv {
  const { character, persona, chat, messages, generationType, connection } = ctx;

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastUserMsg = findLast(messages, (m) => m.is_user);
  const lastCharMsg = findLast(messages, (m) => !m.is_user);

  const isGroup = !!chat.metadata?.group && Array.isArray(chat.metadata?.character_ids);
  const allGroupNames = ctx.groupCharacterNames;
  const focusedName = isGroup ? (ctx.targetCharacterName || character.name) : "";
  const groupLastSpeaker = isGroup
    ? (findLast(messages, (m) => !m.is_user)?.name || "")
    : "";

  return {
    names: {
      user: persona?.name || "User",
      char: character.name,
      group: allGroupNames?.join(", ") ?? "",
      groupNotMuted: (ctx.groupNotMutedNames ?? allGroupNames)?.join(", ") ?? "",
      notChar: persona?.name || "User",
      charGroupFocused: focusedName,
      groupOthers: isGroup && allGroupNames
        ? allGroupNames.filter((n) => n !== focusedName).join(", ")
        : "",
      groupMemberCount: isGroup && allGroupNames ? String(allGroupNames.length) : "0",
      isGroupChat: isGroup ? "yes" : "no",
      groupLastSpeaker,
    },
    character: {
      name: character.name,
      description: character.description || "",
      personality: character.personality || "",
      scenario: character.scenario || "",
      persona: buildPersonaWithAddons(persona),
      mesExamples: character.mes_example || "",
      mesExamplesRaw: character.mes_example || "",
      systemPrompt: character.system_prompt || "",
      postHistoryInstructions: character.post_history_instructions || "",
      depthPrompt: (character.extensions?.depth_prompt as string) || "",
      creatorNotes: character.creator_notes || "",
      version: (character.extensions?.version as string) || "",
      creator: character.creator || "",
      firstMessage: character.first_mes || "",
    },
    chat: {
      id: chat.id,
      messageCount: messages.length,
      lastMessage: lastMsg?.content || "",
      lastMessageName: lastMsg?.name || "",
      lastUserMessage: lastUserMsg?.content || "",
      lastCharMessage: lastCharMsg?.content || "",
      lastMessageId: lastMsg ? messages.length - 1 : -1,
      firstIncludedMessageId: messages.length > 0 ? 0 : -1,
      lastSwipeId: lastMsg?.swipes ? lastMsg.swipes.length - 1 : 0,
      currentSwipeId: lastMsg?.swipe_id ?? 0,
    },
    system: {
      model: connection?.model || "",
      maxPrompt: 0,
      maxContext: 0,
      maxResponse: 0,
      lastGenerationType: generationType,
      isMobile: false,
    },
    variables: {
      local: new Map(Object.entries((chat.metadata?.macro_variables?.local as Record<string, string>) || {})),
      global: new Map(Object.entries((chat.metadata?.macro_variables?.global as Record<string, string>) || {})),
      chat: new Map(Object.entries((chat.metadata?.chat_variables as Record<string, string>) || {})),
    },
    dynamicMacros: ctx.dynamicMacros || {},
    _dynamicMacrosLower: buildDynamicLookup(ctx.dynamicMacros),
    extra: {
      userId: ctx.userId ?? (chat as any).user_id as string | undefined,
      messages: messages.map((m) => ({ content: m.content, name: m.name, is_user: m.is_user })),
      chatCreatedAt: (chat as any).created_at as number | undefined,
      characterTags: Array.isArray((character as any).tags) ? (character as any).tags : [],
    },
  };
}

/** Build a lowercase-keyed Map from dynamicMacros for O(1) lookup. */
function buildDynamicLookup(
  macros?: Record<string, string | import("./types").MacroHandler | import("./types").MacroDefinition>,
): Map<string, string | import("./types").MacroHandler | import("./types").MacroDefinition> | undefined {
  if (!macros) return undefined;
  const keys = Object.keys(macros);
  if (keys.length === 0) return undefined;
  const map = new Map<string, string | import("./types").MacroHandler | import("./types").MacroDefinition>();
  for (const k of keys) {
    map.set(k.toLowerCase(), macros[k]);
  }
  return map;
}

/**
 * Resolve group character names from chat metadata for group chats.
 * Returns the names array, or undefined if not a group chat.
 * @param chat The chat object
 * @param getCharacterName Lookup function: (characterId) => name | undefined
 */
export function resolveGroupCharacterNames(
  chat: Chat,
  getCharacterName: (id: string) => string | undefined,
): string[] | undefined {
  const meta = chat.metadata;
  if (!meta?.group || !Array.isArray(meta.character_ids)) return undefined;
  const names: string[] = [];
  for (const cid of meta.character_ids as string[]) {
    const name = getCharacterName(cid);
    if (name) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

function buildPersonaWithAddons(persona: Persona | null): string {
  if (!persona) return "";
  const base = persona.description || "";

  // Persona-specific add-ons
  const personaAddons = persona.metadata?.addons;
  const enabledPersonaContent = Array.isArray(personaAddons)
    ? personaAddons
        .filter((a: any) => a.enabled && a.content)
        .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((a: any) => a.content.trim())
        .filter(Boolean)
    : [];

  // Global add-ons (resolved upstream in prompt assembly, injected into metadata)
  const globalAddons = persona.metadata?._resolvedGlobalAddons;
  const enabledGlobalContent = Array.isArray(globalAddons)
    ? globalAddons
        .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((a: any) => ((a.content as string) || "").trim())
        .filter(Boolean)
    : [];

  const allContent = [...enabledPersonaContent, ...enabledGlobalContent];
  if (allContent.length === 0) return base;
  return base ? `${base}\n${allContent.join("\n")}` : allContent.join("\n");
}

function findLast(messages: Message[], predicate: (m: Message) => boolean): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i])) return messages[i];
  }
  return null;
}
