import { Hono } from "hono";
import { evaluate, buildEnv, resolveGroupCharacterNames, registry, initMacros } from "../macros";
import { getEffectiveCharacterName } from "../types/character";
import type { Chat } from "../types/chat";
import type { MacroEnv } from "../macros";
import * as chatsSvc from "../services/chats.service";
import * as charactersSvc from "../services/characters.service";
import * as personasSvc from "../services/personas.service";
import * as connectionsSvc from "../services/connections.service";
import { populateLumiaLoomContext } from "../services/prompt-assembly.service";

// Ensure macros are initialized
initMacros();

const app = new Hono();

/**
 * POST /resolve
 * Resolve macro template text using the provided context.
 */
app.post("/resolve", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    template: string;
    chat_id?: string;
    character_id?: string;
    persona_id?: string;
    connection_id?: string;
    dynamic_macros?: Record<string, string>;
  }>();

  if (!body.template) {
    return c.json({ text: "", diagnostics: [] });
  }

  // Build environment from context IDs
  const env = buildEnvFromIds(userId, body);

  const result = await evaluate(body.template, env, registry);
  return c.json({ text: result.text, diagnostics: result.diagnostics });
});

/**
 * POST /resolve-batch
 * Resolve multiple macro templates in a single call with a shared environment.
 * Accepts { templates: Record<string, string>, ...context }.
 * Returns { resolved: Record<string, string> }.
 */
app.post("/resolve-batch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    templates: Record<string, string>;
    chat_id?: string;
    character_id?: string;
    persona_id?: string;
    connection_id?: string;
    dynamic_macros?: Record<string, string>;
  }>();

  if (!body.templates || typeof body.templates !== "object") {
    return c.json({ resolved: {} });
  }

  const entries = Object.entries(body.templates);
  if (entries.length === 0) {
    return c.json({ resolved: {} });
  }

  // Cap at 100 templates per request
  if (entries.length > 100) {
    return c.json({ error: "Too many templates (max 100)" }, 400);
  }

  // Build environment once and reuse for all templates
  const env = buildEnvFromIds(userId, body);
  const resolved: Record<string, string> = {};

  for (const [key, template] of entries) {
    if (!template) {
      resolved[key] = "";
      continue;
    }
    const result = await evaluate(template, env, registry);
    resolved[key] = result.text;
  }

  return c.json({ resolved });
});

/**
 * GET /
 * Return the full macro catalog grouped by category.
 */
app.get("/", (c) => {
  const categories = registry.getCategories().map((cat) => ({
    category: cat.category,
    macros: cat.macros.map((m) => ({
      name: m.name,
      syntax: formatSyntax(m),
      description: m.description,
      args: m.args?.map((a) => ({ name: a.name, optional: a.optional ?? false })),
      returns: m.returns || m.returnType,
      category: m.category,
    })),
  }));

  return c.json({ categories });
});

function formatSyntax(m: { name: string; args?: { name: string; optional?: boolean }[] }): string {
  let syntax = `{{${m.name}`;
  if (m.args?.length) {
    for (const arg of m.args) {
      syntax += `::${arg.optional ? `[${arg.name}]` : arg.name}`;
    }
  }
  syntax += "}}";
  return syntax;
}

function buildEnvFromIds(userId: string, body: {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  connection_id?: string;
  dynamic_macros?: Record<string, string>;
}): MacroEnv {
  // Try to load from chat context first
  if (body.chat_id) {
    const chat = chatsSvc.getChat(userId, body.chat_id);
    if (chat) {
      const messages = chatsSvc.getMessages(userId, body.chat_id);
      const character = charactersSvc.getCharacter(userId, chat.character_id);
      if (character) {
        const persona = personasSvc.resolvePersonaOrDefault(userId, body.persona_id);

        const connection = body.connection_id
          ? connectionsSvc.getConnection(userId, body.connection_id)
          : connectionsSvc.getDefaultConnection(userId);

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
          dynamicMacros: body.dynamic_macros,
          groupCharacterNames,
          targetCharacterName: isGroup ? getEffectiveCharacterName(character) : undefined,
        });
        populateLumiaLoomContext(env, userId, chat);
        return env;
      }
    }
  }

  // Try character-only context
  if (body.character_id) {
    const character = charactersSvc.getCharacter(userId, body.character_id);
    if (character) {
      const persona = personasSvc.resolvePersonaOrDefault(userId, body.persona_id);

      const connection = body.connection_id
        ? connectionsSvc.getConnection(userId, body.connection_id)
        : connectionsSvc.getDefaultConnection(userId);

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
        dynamicMacros: body.dynamic_macros,
      });
      populateLumiaLoomContext(env, userId, chat);
      return env;
    }
  }

  // Minimal fallback env
  const persona = personasSvc.getDefaultPersona(userId);
  const connection = connectionsSvc.getDefaultConnection(userId);

  return {
    names: {
      user: persona?.name || "User", char: "", group: "", groupNotMuted: "", notChar: persona?.name || "User",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", groupLastSpeaker: "",
    },
    character: {
      name: "", description: "", personality: "", scenario: "", persona: persona?.description || "",
      personaSubjectivePronoun: persona?.subjective_pronoun || "",
      personaObjectivePronoun: persona?.objective_pronoun || "",
      personaPossessivePronoun: persona?.possessive_pronoun || "",
      mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "",
      depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "",
      lastCharMessage: "", lastMessageId: -1, firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0,
    },
    system: {
      model: connection?.model || "", maxPrompt: 0, maxContext: 0, maxResponse: 0,
      lastGenerationType: "normal", isMobile: false,
    },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros: body.dynamic_macros || {},
    extra: {},
  };
}

export { app as macrosRoutes };
