import { getDb } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverSession,
  DreamWeaverWorkspace,
  DreamWeaverWorkspaceKind,
  CreateSessionInput,
  FinalizeSessionInput,
  UpdateSessionInput,
  LorebookEntry,
  NpcEntry,
  DW_DRAFT_V1,
  DreamWeaverVisualAsset,
} from "../../types/dream-weaver";
import * as charactersSvc from "../characters.service";
import * as chatsSvc from "../chats.service";
import * as imagesSvc from "../images.service";
import * as worldBooksSvc from "../world-books.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
import { deriveWorkspace } from "./messages.service";
import * as messagesSvc from "./messages.service";
import { getTool } from "./tools/registry";
import { executeTool } from "./tools/executor";
import { getAcceptedPortraitReference } from "./portrait-reference";

function rowToSession(row: any): DreamWeaverSession {
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dream_text: row.dream_text ?? "",
    tone: row.tone ?? null,
    constraints: row.constraints ?? null,
    dislikes: row.dislikes ?? null,
    persona_id: row.persona_id ?? null,
    connection_id: row.connection_id ?? null,
    model: row.model ?? null,
    workspace_kind: row.workspace_kind === "scenario" ? "scenario" : "character",
    status: row.status,
    character_id: row.character_id ?? null,
    launch_chat_id: row.launch_chat_id ?? null,
  };
}

function normalizeWorkspaceKind(value: unknown): DreamWeaverWorkspaceKind {
  return value === "scenario" ? "scenario" : "character";
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

const EMPTY_VOICE_GUIDANCE = {
  compiled: "",
  rules: { baseline: [], rhythm: [], diction: [], quirks: [], hard_nos: [] },
};

function cloneRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeVisualAssets(value: unknown): DreamWeaverVisualAsset[] {
  if (!Array.isArray(value)) throw new Error("visual_assets must be an array");
  return value.map((raw, index) => {
    const asset = cloneRecord(raw);
    const id = typeof asset.id === "string" && asset.id.trim() ? asset.id.trim() : `asset-${index + 1}`;
    const references = Array.isArray(asset.references)
      ? asset.references
        .filter((ref: unknown) => ref && typeof ref === "object" && !Array.isArray(ref))
        .map((ref: any, refIndex: number) => ({
          id: typeof ref.id === "string" && ref.id.trim() ? ref.id.trim() : `${id}-ref-${refIndex + 1}`,
          image_id: typeof ref.image_id === "string" && ref.image_id.trim() ? ref.image_id.trim() : null,
          image_url: typeof ref.image_url === "string" && ref.image_url.trim() ? ref.image_url.trim() : null,
          weight: typeof ref.weight === "number" ? ref.weight : undefined,
          label: typeof ref.label === "string" && ref.label.trim() ? ref.label.trim() : undefined,
        }))
      : [];

    return {
      id,
      asset_type: "card_portrait",
      label: typeof asset.label === "string" && asset.label.trim() ? asset.label.trim() : "Main Portrait",
      prompt: typeof asset.prompt === "string" ? asset.prompt : "",
      negative_prompt: typeof asset.negative_prompt === "string" ? asset.negative_prompt : "",
      macro_tokens: Array.isArray(asset.macro_tokens)
        ? asset.macro_tokens.filter((item: unknown) => typeof item === "string")
        : [],
      width: typeof asset.width === "number" && Number.isFinite(asset.width) ? asset.width : 832,
      height: typeof asset.height === "number" && Number.isFinite(asset.height) ? asset.height : 1216,
      aspect_ratio: typeof asset.aspect_ratio === "string" && asset.aspect_ratio.trim() ? asset.aspect_ratio.trim() : "2:3",
      seed: typeof asset.seed === "number" && Number.isFinite(asset.seed) ? asset.seed : null,
      references,
      provider: typeof asset.provider === "string" ? asset.provider as DreamWeaverVisualAsset["provider"] : null,
      preset_id: typeof asset.preset_id === "string" && asset.preset_id.trim() ? asset.preset_id.trim() : null,
      provider_state: cloneRecord(asset.provider_state),
    };
  });
}

function workspaceToLegacyDraft(workspace: DreamWeaverWorkspace): DW_DRAFT_V1 {
  const visualAssets = workspace.visual_assets ?? [];
  return {
    format: "DW_DRAFT_V1",
    version: 1,
    kind: workspace.kind,
    meta: { title: workspace.name ?? "", summary: "", tags: [], content_rating: "sfw" },
    card: {
      name: workspace.name ?? "",
      appearance: workspace.appearance ?? "",
      appearance_data: (workspace.appearance_data ?? {}) as Record<string, string>,
      description: workspace.appearance ?? "",
      personality: workspace.personality ?? "",
      scenario: workspace.scenario ?? "",
      first_mes: workspace.first_mes ?? "",
      system_prompt: "",
      post_history_instructions: "",
    },
    voice_guidance: workspace.voice_guidance ?? EMPTY_VOICE_GUIDANCE,
    alternate_fields: { description: [], personality: [], scenario: [] },
    greetings: workspace.greeting
      ? [{ id: "greeting-0", label: "Greeting", content: workspace.greeting }]
      : [],
    lorebooks: workspace.lorebooks,
    npc_definitions: workspace.npcs,
    regex_scripts: [],
    visual_assets: visualAssets,
    image_assets: visualAssets.map((asset) => ({
      id: asset.id,
      type: "portrait",
      label: asset.label,
      prompt: asset.prompt,
      negative: asset.negative_prompt,
      imageId: asset.references[0]?.image_id ?? null,
      imageUrl: asset.references[0]?.image_url ?? null,
      locked: false,
    })),
  };
}

export function createSession(userId: string, input: CreateSessionInput): DreamWeaverSession {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const dreamText = input.dream_text?.trim() ?? "";

  db.prepare(`
    INSERT INTO dream_weaver_sessions (
      id, user_id, created_at, updated_at,
      dream_text, tone, constraints, dislikes, persona_id, connection_id, model, workspace_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    now,
    now,
    dreamText,
    input.tone?.trim() || null,
    input.constraints?.trim() || null,
    input.dislikes?.trim() || null,
    input.persona_id || null,
    input.connection_id || null,
    normalizeOptionalText(input.model),
    normalizeWorkspaceKind(input.workspace_kind),
  );

  return getSession(userId, id)!;
}

export function getSession(userId: string, sessionId: string): DreamWeaverSession | null {
  const row = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).get(sessionId, userId) as any;

  return row ? rowToSession(row) : null;
}

export function listSessions(userId: string): DreamWeaverSession[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId) as any[];

  return rows.map(rowToSession);
}

export async function updateSession(
  userId: string,
  sessionId: string,
  input: UpdateSessionInput,
): Promise<DreamWeaverSession> {
  const existing = getSession(userId, sessionId);
  if (!existing) throw new Error("Session not found");

  const updates: string[] = [];
  const params: any[] = [];
  if ("dream_text" in input) {
    const dreamText = input.dream_text?.trim() ?? "";
    updates.push("dream_text = ?");
    params.push(dreamText);
  }

  if ("tone" in input) {
    updates.push("tone = ?");
    params.push(normalizeOptionalText(input.tone));
  }

  if ("constraints" in input) {
    updates.push("constraints = ?");
    params.push(normalizeOptionalText(input.constraints));
  }

  if ("dislikes" in input) {
    updates.push("dislikes = ?");
    params.push(normalizeOptionalText(input.dislikes));
  }

  if ("persona_id" in input) {
    updates.push("persona_id = ?");
    params.push(normalizeOptionalText(input.persona_id));
  }

  if ("connection_id" in input) {
    updates.push("connection_id = ?");
    params.push(normalizeOptionalText(input.connection_id));
  }

  if ("model" in input) {
    updates.push("model = ?");
    params.push(normalizeOptionalText(input.model));
  }

  if ("workspace_kind" in input) {
    updates.push("workspace_kind = ?");
    params.push(normalizeWorkspaceKind(input.workspace_kind));
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  params.push(Math.floor(Date.now() / 1000));
  params.push(sessionId, userId);

  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET ${updates.join(", ")}
    WHERE id = ? AND user_id = ?
  `).run(...params);

  return getSession(userId, sessionId)!;
}

export function updateVisualAssets(
  userId: string,
  sessionId: string,
  visualAssetsInput: unknown,
): DreamWeaverWorkspace {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const visualAssets = normalizeVisualAssets(visualAssetsInput);
  messagesSvc.invalidateDraftCache(sessionId);
  const workspace = {
    ...deriveWorkspace(userId, sessionId),
    visual_assets: visualAssets,
  };
  const draft = workspaceToLegacyDraft(workspace);

  getDb()
    .prepare(`
      UPDATE dream_weaver_sessions
         SET draft = ?,
             updated_at = unixepoch()
       WHERE id = ? AND user_id = ?
    `)
    .run(JSON.stringify(draft), sessionId, userId);

  messagesSvc.invalidateDraftCache(sessionId);
  return deriveWorkspace(userId, sessionId);
}

export function getLegacyDraftSnapshot(userId: string, sessionId: string): DW_DRAFT_V1 {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  return workspaceToLegacyDraft(deriveWorkspace(userId, sessionId));
}

function createWorldBooksFromWorkspace(
  userId: string,
  sessionId: string,
  workspace: DreamWeaverWorkspace,
): string[] {
  const ids: string[] = [];
  if (workspace.lorebooks.length > 0) {
    const book = worldBooksSvc.createWorldBook(userId, {
      name: `${workspace.name ?? "Dream"} Lorebook`,
      description: "Generated by Dream Weaver",
      metadata: { dream_weaver: { session_id: sessionId, kind: "lorebook" } },
    });
    for (let i = 0; i < workspace.lorebooks.length; i++) {
      const e: LorebookEntry = workspace.lorebooks[i];
      worldBooksSvc.createEntry(userId, book.id, {
        comment: e.comment,
        key: e.key,
        content: e.content,
      });
    }
    ids.push(book.id);
  }
  if (workspace.npcs.length > 0) {
    const npcBook = worldBooksSvc.createWorldBook(userId, {
      name: `${workspace.name ?? "Dream"} NPCs`,
      description: "Generated NPCs by Dream Weaver",
      metadata: { dream_weaver: { session_id: sessionId, kind: "npcs" } },
    });
    for (let i = 0; i < workspace.npcs.length; i++) {
      const n: NpcEntry = workspace.npcs[i];
      worldBooksSvc.createEntry(userId, npcBook.id, {
        comment: n.name,
        key: [n.name],
        content: formatNpcEntryContent(n, workspace.name ?? ""),
      });
    }
    ids.push(npcBook.id);
  }
  return ids;
}

function formatNpcEntryContent(npc: NpcEntry, characterName: string): string {
  const lines = [`# ${npc.name}`, "", npc.description];
  if (npc.voice_notes) lines.push("", `**Voice:** ${npc.voice_notes}`);
  if (characterName) lines.push("", `**Relationship to ${characterName}:** see scenario.`);
  return lines.join("\n");
}

export async function finalize(
  userId: string,
  sessionId: string,
  input: FinalizeSessionInput = {},
): Promise<DreamWeaverSession> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const workspace = deriveWorkspace(userId, sessionId);
  if (!workspace.name || !workspace.personality || !workspace.first_mes) {
    throw new Error("Workspace incomplete: name/title, behavior, and opening message are required");
  }

  const persistedDraft = workspaceToLegacyDraft(workspace);
  const persistedPortrait = getAcceptedPortraitReference(persistedDraft)?.reference.image_id ?? null;
  const acceptedPortraitImageId = normalizeOptionalText(input.accepted_portrait_image_id) ?? persistedPortrait;
  if (acceptedPortraitImageId && !imagesSvc.getImage(userId, acceptedPortraitImageId)) {
    throw new Error("Portrait image not found");
  }

  let characterId = session.character_id ?? null;
  let launchChatId = session.launch_chat_id ?? null;
  const worldBookIds = createWorldBooksFromWorkspace(userId, sessionId, workspace);
  let previousGeneratedWorldBookIds: string[] = [];

  if (characterId) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (character) {
      const existingExtensions = (character.extensions ?? {}) as Record<string, any>;
      previousGeneratedWorldBookIds = Array.isArray(existingExtensions.dream_weaver?.generated_world_book_ids)
        ? existingExtensions.dream_weaver.generated_world_book_ids.filter((id: unknown) => typeof id === "string" && id)
        : [];
      const existingWorldBookIds = getCharacterWorldBookIds(existingExtensions);
      const preservedWorldBookIds = existingWorldBookIds.filter((id) => !previousGeneratedWorldBookIds.includes(id));
      const dreamWeaverMeta = {
        ...existingExtensions.dream_weaver,
        kind: workspace.kind,
        appearance: workspace.appearance ?? "",
        appearance_data: workspace.appearance_data ?? {},
        voice_guidance: workspace.voice_guidance ?? undefined,
        sources: workspace.sources,
        generated_world_book_ids: worldBookIds,
      };
      const nextExtensions = setCharacterWorldBookIds(existingExtensions, [...preservedWorldBookIds, ...worldBookIds]);
      charactersSvc.updateCharacter(userId, characterId, {
        name: workspace.name,
        description: workspace.appearance ?? character.description ?? "",
        personality: workspace.personality,
        scenario: workspace.scenario ?? "",
        first_mes: workspace.first_mes,
        extensions: { ...nextExtensions, dream_weaver: dreamWeaverMeta },
      });
      if (acceptedPortraitImageId) {
        charactersSvc.setCharacterImage(userId, characterId, acceptedPortraitImageId);
      }
      for (const oldId of previousGeneratedWorldBookIds) {
        if (!worldBookIds.includes(oldId)) worldBooksSvc.deleteWorldBook(userId, oldId);
      }
    } else {
      characterId = null;
      launchChatId = null;
    }
  }

  if (!characterId) {
    let extensions: Record<string, any> = {};
    extensions = setCharacterWorldBookIds(extensions, worldBookIds);
    extensions.dream_weaver = {
      kind: workspace.kind,
      appearance: workspace.appearance ?? "",
      appearance_data: workspace.appearance_data ?? {},
      voice_guidance: workspace.voice_guidance ?? undefined,
      sources: workspace.sources,
      generated_world_book_ids: worldBookIds,
    };
    const created = charactersSvc.createCharacter(userId, {
      name: workspace.name,
      description: workspace.appearance ?? "",
      personality: workspace.personality,
      scenario: workspace.scenario ?? "",
      first_mes: workspace.first_mes,
      extensions,
    });
    characterId = created.id;
    if (acceptedPortraitImageId) {
      charactersSvc.setCharacterImage(userId, characterId, acceptedPortraitImageId);
    }
  }

  if (!launchChatId) {
    const launchChat = chatsSvc.createChat(userId, {
      character_id: characterId!,
      name: workspace.name,
    });
    launchChatId = launchChat.id;
  }

  getDb()
    .prepare(`
      UPDATE dream_weaver_sessions
         SET status = 'finalized',
             character_id = ?,
             launch_chat_id = ?,
             updated_at = unixepoch()
       WHERE id = ? AND user_id = ?
    `)
    .run(characterId, launchChatId, sessionId, userId);

  eventBus.emit(EventType.DREAM_WEAVER_FINALIZED, { sessionId, characterId, chatId: launchChatId }, userId);

  return getSession(userId, sessionId)!;
}

export function deleteSession(userId: string, sessionId: string): void {
  getDb().prepare(`
    DELETE FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);
}

export function dreamFanOut(userId: string, sessionId: string): void {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  appendDreamSource(userId, sessionId);
}

export function appendDreamSource(userId: string, sessionId: string) {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const content = session.dream_text.trim();
  if (!content) throw new Error("Dream text is empty");

  return messagesSvc.appendMessage({
    sessionId,
    userId,
    kind: "source_card",
    payload: {
      id: crypto.randomUUID(),
      type: "dream",
      title: "Dream",
      content,
      tone: session.tone,
      constraints: session.constraints,
      dislikes: session.dislikes,
    },
    status: "accepted",
  });
}

const inflightAborts = new Map<string, AbortController>();

export async function runToolCard(userId: string, messageId: string): Promise<void> {
  const message = messagesSvc.getMessage(userId, messageId);
  if (!message || message.kind !== "tool_card") return;
  const tool = getTool(message.tool_name!);
  if (!tool) {
    messagesSvc.updateToolCard(userId, messageId, {
      status: "pending",
      error: { message: `Unknown tool: ${message.tool_name}` },
      durationMs: 0,
    });
    return;
  }
  const session = getSession(userId, message.session_id);
  if (!session) return;

  const ac = new AbortController();
  inflightAborts.set(messageId, ac);

  try {
    const draft = messagesSvc.deriveWorkspace(userId, message.session_id);
    const payload = message.payload as any;
    const result = await executeTool({
      userId,
      tool,
      session,
      draft,
      args: payload.args ?? {},
      nudgeText: payload.nudge_text ?? null,
      signal: ac.signal,
    });
    messagesSvc.updateToolCard(userId, messageId, {
      status: "pending",
      output: result.output as any,
      error: null,
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
    });
  } catch (err: any) {
    if (ac.signal.aborted) {
      messagesSvc.deleteMessage(userId, messageId);
      return;
    }
    messagesSvc.updateToolCard(userId, messageId, {
      status: "pending",
      error: { message: err.message ?? "Tool execution failed" },
      durationMs: 0,
    });
  } finally {
    inflightAborts.delete(messageId);
  }
}

export function cancelToolCard(userId: string, messageId: string): void {
  const ac = inflightAborts.get(messageId);
  if (ac) ac.abort();
}
