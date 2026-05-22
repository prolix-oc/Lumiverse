import { buildEnv, initMacros, mergeDynamicMacros, resolveGroupCharacterNames, resolvePersonaPronouns } from "../macros";
import type { MacroEnv } from "../macros";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { getEffectiveCharacterName } from "../types/character";
import type { Chat } from "../types/chat";
import type { RegexPlacement, RegexScript } from "../types/regex-script";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as personasSvc from "./personas.service";
import { populateLumiaLoomContext } from "./prompt-assembly.service";
import { applyRegexScripts } from "./regex-scripts.service";

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
      const character = charactersSvc.getCharacter(userId, chat.character_id);
      if (character) {
        const persona = personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id);
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
      const persona = personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id);
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

  const persona = personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id);
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
      groupLastSpeaker: "",
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
  if (env) {
    const dyn: Record<string, string> = { ...(input.dynamicMacros ?? {}) };
    if (input.context.role && dyn.role === undefined) {
      dyn.role = input.context.role;
    }
    if (Object.keys(dyn).length > 0) {
      mergeDynamicMacros(env, dyn);
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
  return {
    result,
    touchedVars: fingerprint.touchedVars,
    cacheable: fingerprint.cacheable,
  };
}
