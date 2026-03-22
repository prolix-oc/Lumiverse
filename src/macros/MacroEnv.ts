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
  dynamicMacros?: Record<string, string | MacroHandler | MacroDefinition>;
}

export function buildEnv(ctx: BuildEnvContext): MacroEnv {
  const { character, persona, chat, messages, generationType, connection } = ctx;

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastUserMsg = findLast(messages, (m) => m.is_user);
  const lastCharMsg = findLast(messages, (m) => !m.is_user);

  return {
    names: {
      user: persona?.name || "User",
      char: character.name,
      group: "", // groups not yet supported
      groupNotMuted: "",
      notChar: persona?.name || "User",
    },
    character: {
      name: character.name,
      description: character.description || "",
      personality: character.personality || "",
      scenario: character.scenario || "",
      persona: persona?.description || "",
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
    },
    dynamicMacros: ctx.dynamicMacros || {},
    _dynamicMacrosLower: buildDynamicLookup(ctx.dynamicMacros),
    extra: {},
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

function findLast(messages: Message[], predicate: (m: Message) => boolean): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i])) return messages[i];
  }
  return null;
}
