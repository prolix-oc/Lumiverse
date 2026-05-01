import { getDb } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverSession,
  DreamWeaverWorkspace,
  DreamWeaverWorkspaceKind,
  CreateSessionInput,
  UpdateSessionInput,
  LorebookEntry,
  NpcEntry,
} from "../../types/dream-weaver";
import * as charactersSvc from "../characters.service";
import * as chatsSvc from "../chats.service";
import * as worldBooksSvc from "../world-books.service";
import { setCharacterWorldBookIds } from "../../utils/character-world-books";
import { deriveWorkspace } from "./messages.service";
import * as messagesSvc from "./messages.service";
import { getTool } from "./tools/registry";
import { executeTool } from "./tools/executor";

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


function createWorldBooksFromWorkspace(userId: string, workspace: DreamWeaverWorkspace): string[] {
  const ids: string[] = [];
  if (workspace.lorebooks.length > 0) {
    const book = worldBooksSvc.createWorldBook(userId, {
      name: `${workspace.name ?? "Dream"} Lorebook`,
      description: "Generated by Dream Weaver",
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
): Promise<DreamWeaverSession> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const workspace = deriveWorkspace(userId, sessionId);
  if (!workspace.name || !workspace.personality || !workspace.first_mes) {
    throw new Error("Workspace incomplete: name/title, behavior, and opening message are required");
  }

  const worldBookIds = createWorldBooksFromWorkspace(userId, workspace);

  let characterId = session.character_id ?? null;

  if (characterId) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (character) {
      const existingExtensions = (character.extensions ?? {}) as Record<string, any>;
      const dreamWeaverMeta = {
        ...existingExtensions.dream_weaver,
        kind: workspace.kind,
        appearance: workspace.appearance ?? "",
        appearance_data: workspace.appearance_data ?? {},
        voice_guidance: workspace.voice_guidance ?? undefined,
        sources: workspace.sources,
      };
      const nextExtensions = setCharacterWorldBookIds(existingExtensions, worldBookIds);
      charactersSvc.updateCharacter(userId, characterId, {
        name: workspace.name,
        description: workspace.appearance ?? character.description ?? "",
        personality: workspace.personality,
        scenario: workspace.scenario ?? "",
        first_mes: workspace.first_mes,
        extensions: { ...nextExtensions, dream_weaver: dreamWeaverMeta },
      });
    } else {
      characterId = null;
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
  }

  const launchChat = chatsSvc.createChat(userId, {
    character_id: characterId!,
    name: workspace.name,
  });

  getDb()
    .prepare(`
      UPDATE dream_weaver_sessions
         SET status = 'finalized',
             character_id = ?,
             launch_chat_id = ?,
             updated_at = unixepoch()
       WHERE id = ? AND user_id = ?
    `)
    .run(characterId, launchChat.id, sessionId, userId);

  eventBus.emit(EventType.DREAM_WEAVER_FINALIZED, { sessionId, characterId, chatId: launchChat.id }, userId);

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
