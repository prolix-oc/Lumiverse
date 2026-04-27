import { getDb, onDbReset } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverSession,
  CreateSessionInput,
  UpdateSessionInput,
  DraftV2,
  LorebookEntry,
  NpcEntry,
} from "../../types/dream-weaver";
import * as charactersSvc from "../characters.service";
import * as chatsSvc from "../chats.service";
import * as worldBooksSvc from "../world-books.service";
import { setCharacterWorldBookIds } from "../../utils/character-world-books";
import { deriveDraft } from "./messages.service";
import * as messagesSvc from "./messages.service";
import { listSoulTools, getTool } from "./tools/registry";
import { executeTool } from "./tools/executor";

const DREAM_WEAVER_REQUIRED_COLUMNS: Array<[name: string, definition: string]> = [
  ["dream_text", "TEXT NOT NULL DEFAULT ''"],
  ["tone", "TEXT"],
  ["constraints", "TEXT"],
  ["dislikes", "TEXT"],
  ["persona_id", "TEXT"],
  ["connection_id", "TEXT"],
  ["model", "TEXT"],
  ["character_id", "TEXT"],
  ["launch_chat_id", "TEXT"],
];

let dreamWeaverSchemaEnsured = false;

onDbReset(() => {
  dreamWeaverSchemaEnsured = false;
});

function createDreamWeaverTable(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS dream_weaver_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      dream_text TEXT NOT NULL,
      tone TEXT,
      constraints TEXT,
      dislikes TEXT,
      persona_id TEXT,
      connection_id TEXT,
      model TEXT,
      draft TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      soul_state TEXT NOT NULL DEFAULT 'empty',
      world_state TEXT NOT NULL DEFAULT 'empty',
      soul_revision INTEGER NOT NULL DEFAULT 0,
      world_source_revision INTEGER,
      character_id TEXT,
      launch_chat_id TEXT,
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
      FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);
}

function ensureDreamWeaverSchema(): void {
  if (dreamWeaverSchemaEnsured) return;

  const db = getDb();
  const existingTable = db
    .query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'dream_weaver_sessions'
    `)
    .get() as { name: string } | null;

  if (!existingTable) {
    createDreamWeaverTable();
    dreamWeaverSchemaEnsured = true;
    return;
  }

  const columns = db.query("PRAGMA table_info(dream_weaver_sessions)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasLegacyDreamDescription = columnNames.has("dream_description");
  const hasLegacyDraftData = columnNames.has("draft_data");

  for (const [columnName, definition] of DREAM_WEAVER_REQUIRED_COLUMNS) {
    if (!columnNames.has(columnName)) {
      db.run(`ALTER TABLE dream_weaver_sessions ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (hasLegacyDreamDescription) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET dream_text = COALESCE(NULLIF(dream_text, ''), NULLIF(dream_description, ''))
      WHERE COALESCE(dream_text, '') = ''
    `);
  }

  if (hasLegacyDraftData) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET draft = CASE
        WHEN draft IS NULL OR draft = '' THEN NULLIF(draft_data, '{}')
        ELSE draft
      END
      WHERE draft IS NULL OR draft = ''
    `);
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);

  dreamWeaverSchemaEnsured = true;
}

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
    draft: null,
    status: row.status,
    soul_state: "empty" as const,
    world_state: "empty" as const,
    soul_revision: 0,
    world_source_revision: null,
    character_id: row.character_id ?? null,
    launch_chat_id: row.launch_chat_id ?? null,
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function createSession(userId: string, input: CreateSessionInput): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const dreamText = input.dream_text.trim();

  if (!dreamText) {
    throw new Error("Dream text is required");
  }

  db.prepare(`
    INSERT INTO dream_weaver_sessions (
      id, user_id, created_at, updated_at,
      dream_text, tone, constraints, dislikes, persona_id, connection_id, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );

  return getSession(userId, id)!;
}

export function getSession(userId: string, sessionId: string): DreamWeaverSession | null {
  ensureDreamWeaverSchema();

  const row = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).get(sessionId, userId) as any;

  return row ? rowToSession(row) : null;
}

export function listSessions(userId: string): DreamWeaverSession[] {
  ensureDreamWeaverSchema();

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
  ensureDreamWeaverSchema();

  const existing = getSession(userId, sessionId);
  if (!existing) throw new Error("Session not found");

  const updates: string[] = [];
  const params: any[] = [];
  if ("dream_text" in input) {
    const dreamText = input.dream_text?.trim() ?? "";
    if (!dreamText) throw new Error("Dream text is required");
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


function createWorldBooksFromDraft(userId: string, draft: DraftV2): string[] {
  const ids: string[] = [];
  if (draft.lorebooks.length > 0) {
    const book = worldBooksSvc.createWorldBook(userId, {
      name: `${draft.name ?? "Dream"} Lorebook`,
      description: "Generated by Dream Weaver",
    });
    for (let i = 0; i < draft.lorebooks.length; i++) {
      const e: LorebookEntry = draft.lorebooks[i];
      worldBooksSvc.createEntry(userId, book.id, {
        comment: e.comment,
        key: e.key,
        content: e.content,
      });
    }
    ids.push(book.id);
  }
  if (draft.npcs.length > 0) {
    const npcBook = worldBooksSvc.createWorldBook(userId, {
      name: `${draft.name ?? "Dream"} NPCs`,
      description: "Generated NPCs by Dream Weaver",
    });
    for (let i = 0; i < draft.npcs.length; i++) {
      const n: NpcEntry = draft.npcs[i];
      worldBooksSvc.createEntry(userId, npcBook.id, {
        comment: n.name,
        key: [n.name],
        content: formatNpcEntryContent(n, draft.name ?? ""),
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
  ensureDreamWeaverSchema();
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const draft = deriveDraft(userId, sessionId);
  if (!draft.name || !draft.personality || !draft.first_mes) {
    throw new Error("Draft incomplete: name, personality, and first_mes are required");
  }

  const worldBookIds = createWorldBooksFromDraft(userId, draft);

  let characterId = session.character_id ?? null;

  if (characterId) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (character) {
      const existingExtensions = (character.extensions ?? {}) as Record<string, any>;
      const nextExtensions = setCharacterWorldBookIds(existingExtensions, worldBookIds);
      charactersSvc.updateCharacter(userId, characterId, {
        name: draft.name,
        description: draft.appearance ?? character.description ?? "",
        personality: draft.personality,
        scenario: draft.scenario ?? "",
        first_mes: draft.first_mes,
        extensions: nextExtensions,
      });
    } else {
      characterId = null;
    }
  }

  if (!characterId) {
    let extensions: Record<string, any> = {};
    extensions = setCharacterWorldBookIds(extensions, worldBookIds);
    const created = charactersSvc.createCharacter(userId, {
      name: draft.name,
      description: draft.appearance ?? "",
      personality: draft.personality,
      scenario: draft.scenario ?? "",
      first_mes: draft.first_mes,
      extensions,
    });
    characterId = created.id;
  }

  const launchChat = chatsSvc.createChat(userId, {
    character_id: characterId!,
    name: draft.name,
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
  ensureDreamWeaverSchema();

  getDb().prepare(`
    DELETE FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);
}

export function dreamFanOut(userId: string, sessionId: string): void {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  messagesSvc.appendMessage({
    sessionId,
    userId,
    kind: "dream_summary",
    payload: {
      dream_text: session.dream_text,
      tone: session.tone,
      dislikes: session.dislikes,
    },
  });

  for (const tool of listSoulTools()) {
    const card = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "tool_card",
      payload: {
        tool: tool.name,
        args: {},
        output: null,
        error: null,
        nudge_text: null,
        duration_ms: null,
        token_usage: null,
      },
      toolName: tool.name,
      status: "running",
    });
    void runToolCard(userId, card.id);
  }
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
    const draft = messagesSvc.deriveDraft(userId, message.session_id);
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
