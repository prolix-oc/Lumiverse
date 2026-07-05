import { Hono } from "hono";
import { evaluate, buildEnv, resolveGroupCharacterNames, resolvePersonaPronouns, registry, initMacros } from "../macros";
import { getEffectiveCharacterName, makeAssistantCharacter } from "../types/character";
import { isTemporaryChatMetadata } from "../types/chat";
import type { Chat } from "../types/chat";
import type { MacroEnv } from "../macros";
import type { PromptBlock, PromptVariableValue } from "../types/preset";
import type { Preset } from "../types/preset";
import * as chatsSvc from "../services/chats.service";
import * as charactersSvc from "../services/characters.service";
import * as personasSvc from "../services/personas.service";
import { resolvePersonaForChatMacros } from "../services/persona-addon-states";
import * as connectionsSvc from "../services/connections.service";
import * as memoryCortex from "../services/memory-cortex";
import {
  normalizePromptBlockText,
  populateLumiaLoomContext,
  resolvePromptVariables,
} from "../services/prompt-assembly.service";

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
    prompt_blocks?: PromptBlock[];
    prompt_variables?: Record<string, Record<string, PromptVariableValue>>;
    // When true, leading/trailing whitespace is stripped from the resolved
    // text. This mirrors the per-block trim the assembly applies to a prompt
    // block (see prompt-assembly.service.ts), so a block-editor preview
    // matches what a dry run produces. Off by default — callers that resolve
    // free-form text (e.g. the chat input "resolve macros" action) must keep
    // the user's exact whitespace.
    trim?: boolean;
  }>();

  if (!body.template) {
    return c.json({ text: "", diagnostics: [] });
  }

  // Build environment from context IDs
  const env = await buildEnvFromIds(userId, body);
  seedPromptVariablesForPreview(env, body);

  const result = await evaluate(body.template, env, registry);
  return c.json({
    text: body.trim ? normalizePromptBlockText(result.text) : result.text,
    diagnostics: result.diagnostics,
    touched_vars: Array.from(result.touchedVars),
    cacheable: result.cacheable,
  });
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
    prompt_blocks?: PromptBlock[];
    prompt_variables?: Record<string, Record<string, PromptVariableValue>>;
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
  const env = await buildEnvFromIds(userId, body);
  seedPromptVariablesForPreview(env, body);
  const resolved: Record<string, string> = {};
  const touchedVars: Record<string, string[]> = {};
  const cacheable: Record<string, boolean> = {};

  for (const [key, template] of entries) {
    if (!template) {
      resolved[key] = "";
      touchedVars[key] = [];
      cacheable[key] = true;
      continue;
    }
    const result = await evaluate(template, env, registry);
    resolved[key] = result.text;
    touchedVars[key] = Array.from(result.touchedVars);
    cacheable[key] = result.cacheable;
  }

  return c.json({ resolved, touched_vars: touchedVars, cacheable });
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

async function buildEnvFromIds(userId: string, body: {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  connection_id?: string;
  dynamic_macros?: Record<string, string>;
}): Promise<MacroEnv> {
  // Try to load from chat context first
  if (body.chat_id) {
    const chat = chatsSvc.getChat(userId, body.chat_id);
    if (chat) {
      const messages = chatsSvc.getMessages(userId, body.chat_id);
      const isGroup = !!chat.metadata?.group;
      const groupCharacterIds =
        isGroup && Array.isArray(chat.metadata?.character_ids)
          ? (chat.metadata.character_ids as string[])
          : [];
      const targetCharacterId =
        isGroup &&
        typeof body.character_id === "string" &&
        groupCharacterIds.includes(body.character_id)
          ? body.character_id
          : undefined;
      const defaultCharacter = chat.character_id
        ? charactersSvc.getCharacter(userId, chat.character_id)
        : makeAssistantCharacter();
      const focusedCharacter = targetCharacterId
        ? charactersSvc.getCharacter(userId, targetCharacterId) ?? defaultCharacter
        : defaultCharacter;
      const character = focusedCharacter;
      if (character) {
        const persona = isTemporaryChatMetadata(chat.metadata)
          ? null
          : resolvePersonaForChatMacros(
              userId,
              personasSvc.resolvePersonaOrDefault(userId, body.persona_id),
              chat.metadata,
            );

        const connection = connectionsSvc.resolveConnection(userId, body.connection_id);

        const groupCharacterNames = resolveGroupCharacterNames(chat, (cid) => {
          const c = charactersSvc.getCharacter(userId, cid);
          return c ? getEffectiveCharacterName(c) : undefined;
        });
        const env = buildEnv({
          character,
          focusedCharacter,
          persona,
          chat,
          messages,
          generationType: "normal",
          connection,
          dynamicMacros: body.dynamic_macros,
          groupCharacterNames,
          targetCharacterId,
          targetCharacterName: isGroup ? getEffectiveCharacterName(character) : undefined,
        });
        populateLumiaLoomContext(env, userId, chat);
        seedCortexPreviewContext(userId, chat.id, env);
        return env;
      }
    }
  }

  // Try character-only context
  if (body.character_id) {
    const character = charactersSvc.getCharacter(userId, body.character_id);
    if (character) {
      // No chat context here, so there are no per-chat add-on bindings to apply.
      const persona = resolvePersonaForChatMacros(
        userId,
        personasSvc.resolvePersonaOrDefault(userId, body.persona_id),
        null,
      );

      const connection = connectionsSvc.resolveConnection(userId, body.connection_id);

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

  const persona = resolvePersonaForChatMacros(
    userId,
    personasSvc.resolvePersonaOrDefault(userId, body.persona_id),
    null,
  );
  const personaPronouns = resolvePersonaPronouns(persona);
  const connection = connectionsSvc.resolveConnection(userId);

  return {
    commit: true,
    names: {
      user: persona?.name || "User", char: "", group: "", groupNotMuted: "", notChar: persona?.name || "User",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", isNarrator: persona?.is_narrator ? "yes" : "no", groupLastSpeaker: "", groupCardMode: "solo",
    },
    character: {
      name: "", description: "", personality: "", scenario: "", persona: persona?.description || "",
      personaSubjectivePronoun: personaPronouns.subjective,
      personaObjectivePronoun: personaPronouns.objective,
      personaPossessivePronoun: personaPronouns.possessive,
      mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "",
      depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "",
      lastCharMessage: "", lastMessageId: -1, firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "",
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

function seedCortexPreviewContext(
  userId: string,
  chatId: string,
  env: MacroEnv,
): void {
  const config = memoryCortex.getCortexConfig(userId);
  if (!config.enabled) return;

  const cached = memoryCortex.getCachedCortexResult(chatId);
  const colorMap = memoryCortex.formatColorMapForPrompt(chatId);
  if (
    cached &&
    (
      cached.memories.length > 0 ||
      cached.entityContext.length > 0 ||
      cached.activeRelationships.length > 0 ||
      !!cached.arcContext ||
      !!colorMap
    )
  ) {
    env.extra.cortex = {
      memories: cached.memories,
      entityContext: cached.entityContext,
      activeRelationships: cached.activeRelationships,
      arcContext: cached.arcContext,
      colorMap,
    };
    return;
  }

  const maxEntities = Math.max(1, config.retrieval.maxEntitySnapshots);
  const maxRelations = Math.max(1, config.retrieval.maxRelationships);
  const allEntities = memoryCortex.getEntities(chatId);
  const entities = allEntities
    .filter((entity) => entity.status !== "inactive")
    .slice(0, maxEntities);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relations = memoryCortex
    .getRelations(chatId)
    .filter((relation) =>
      entityIds.has(relation.sourceEntityId) ||
      entityIds.has(relation.targetEntityId)
    )
    .slice(0, Math.max(maxRelations, maxEntities * 5));
  const entityById = new Map(allEntities.map((entity) => [entity.id, entity]));

  const entityContext = entities.map((entity) => {
    const entityRelations = relations
      .filter((relation) =>
        relation.sourceEntityId === entity.id ||
        relation.targetEntityId === entity.id
      )
      .slice(0, 5)
      .map((relation) => {
        const targetId = relation.sourceEntityId === entity.id
          ? relation.targetEntityId
          : relation.sourceEntityId;
        return {
          targetName: entityById.get(targetId)?.name ?? "unknown",
          type: relation.relationType,
          label: relation.relationLabel,
          strength: relation.strength,
          sentiment: relation.sentiment,
        };
      });
    return {
      id: entity.id,
      name: entity.name,
      type: entity.entityType,
      status: entity.status,
      description: entity.description,
      lastSeenAt: entity.lastSeenAt,
      mentionCount: entity.mentionCount,
      topFacts: entity.facts.slice(-6),
      emotionalProfile: entity.emotionalValence,
      relationships: entityRelations,
    };
  });

  const activeRelationships = relations.slice(0, maxRelations).map((relation) => ({
    sourceName: entityById.get(relation.sourceEntityId)?.name ?? "unknown",
    targetName: entityById.get(relation.targetEntityId)?.name ?? "unknown",
    type: relation.relationType,
    label: relation.relationLabel,
    strength: relation.strength,
    sentiment: relation.sentiment,
  }));

  const latestArc = memoryCortex
    .getConsolidations(chatId, 2)
    .reduce<ReturnType<typeof memoryCortex.getConsolidations>[number] | null>(
      (latest, current) => {
        if (!latest) return current;
        return (current.messageRangeEnd ?? 0) > (latest.messageRangeEnd ?? 0)
          ? current
          : latest;
      },
      null,
    );
  const arcContext = latestArc
    ? latestArc.title
      ? `[${latestArc.title}] ${latestArc.summary}`
      : latestArc.summary
    : null;

  env.extra.cortex = {
    memories: [],
    entityContext,
    activeRelationships,
    arcContext,
    colorMap,
  };
}

function seedPromptVariablesForPreview(env: MacroEnv, body: {
  prompt_blocks?: PromptBlock[];
  prompt_variables?: Record<string, Record<string, PromptVariableValue>>;
}): void {
  if (!Array.isArray(body.prompt_blocks) || body.prompt_blocks.length === 0) return;
  const preset = {
    id: "preview",
    name: "Preview",
    provider: "preview",
    engine: "preview",
    parameters: {},
    prompt_order: body.prompt_blocks,
    prompts: {},
    metadata: { promptVariables: body.prompt_variables ?? {} },
    created_at: 0,
    updated_at: 0,
  } satisfies Preset;
  resolvePromptVariables(env, body.prompt_blocks, preset);
}

export { app as macrosRoutes };
