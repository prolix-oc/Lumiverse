import { getDb } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverMessage,
  DreamWeaverMessageKind,
  ToolCardStatus,
  DreamWeaverSource,
  DreamWeaverWorkspace,
  DreamWeaverWorkspaceKind,
  ToolCardPayload,
  DW_DRAFT_V1,
} from "../../types/dream-weaver";
import { EMPTY_DREAM_WEAVER_WORKSPACE } from "../../types/dream-weaver";
import { getTool } from "./tools/registry";

function rowToMessage(row: any): DreamWeaverMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    user_id: row.user_id,
    created_at: row.created_at,
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    tool_name: row.tool_name,
    status: row.status,
    supersedes_id: row.supersedes_id,
  };
}

function nextSeq(sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM dream_weaver_messages WHERE session_id = ?`)
    .get(sessionId) as { next: number };
  return row.next;
}

export interface AppendMessageInput {
  sessionId: string;
  userId: string;
  kind: DreamWeaverMessageKind;
  payload: Record<string, unknown>;
  toolName?: string | null;
  status?: ToolCardStatus | null;
  supersedesId?: string | null;
}

export function appendMessage(input: AppendMessageInput): DreamWeaverMessage {
  const id = crypto.randomUUID();
  const seq = nextSeq(input.sessionId);
  getDb()
    .prepare(`
      INSERT INTO dream_weaver_messages
        (id, session_id, user_id, seq, kind, payload, tool_name, status, supersedes_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      input.sessionId,
      input.userId,
      seq,
      input.kind,
      JSON.stringify(input.payload),
      input.toolName ?? null,
      input.status ?? null,
      input.supersedesId ?? null,
    );
  const message = getMessage(input.userId, id)!;
  eventBus.emit(EventType.DREAM_WEAVER_MESSAGE_CREATED, { sessionId: input.sessionId, message }, input.userId);
  return message;
}

export function getMessage(userId: string, messageId: string): DreamWeaverMessage | null {
  const row = getDb()
    .prepare(`SELECT * FROM dream_weaver_messages WHERE id = ? AND user_id = ?`)
    .get(messageId, userId) as any;
  return row ? rowToMessage(row) : null;
}

export function listMessages(userId: string, sessionId: string): DreamWeaverMessage[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM dream_weaver_messages
      WHERE session_id = ? AND user_id = ?
      ORDER BY seq ASC
    `)
    .all(sessionId, userId) as any[];
  return rows.map(rowToMessage);
}

export interface UpdateToolCardInput {
  status?: ToolCardStatus;
  output?: Record<string, unknown> | null;
  error?: { message: string; code?: string } | null;
  durationMs?: number | null;
  tokenUsage?: ToolCardPayload["token_usage"];
}

export function updateToolCard(
  userId: string,
  messageId: string,
  patch: UpdateToolCardInput,
): DreamWeaverMessage {
  const existing = getMessage(userId, messageId);
  if (!existing) throw new Error("Message not found");
  if (existing.kind !== "tool_card") throw new Error("Not a tool card");

  const payload = existing.payload as unknown as ToolCardPayload;
  const nextPayload: ToolCardPayload = {
    ...payload,
    output: patch.output !== undefined ? patch.output : payload.output,
    error: patch.error !== undefined ? patch.error : payload.error,
    duration_ms: patch.durationMs !== undefined ? patch.durationMs : payload.duration_ms,
    token_usage: patch.tokenUsage !== undefined ? patch.tokenUsage : payload.token_usage,
  };

  const nextStatus = patch.status ?? existing.status;
  getDb()
    .prepare(`UPDATE dream_weaver_messages SET payload = ?, status = ? WHERE id = ?`)
    .run(JSON.stringify(nextPayload), nextStatus, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(
    EventType.DREAM_WEAVER_MESSAGE_UPDATED,
    {
      sessionId: existing.session_id,
      messageId,
      status: updated.status,
      output: nextPayload.output,
      error: nextPayload.error,
      duration_ms: nextPayload.duration_ms,
      token_usage: nextPayload.token_usage,
    },
    userId,
  );
  return updated;
}

export function deleteMessage(userId: string, messageId: string): void {
  const existing = getMessage(userId, messageId);
  if (!existing) return;
  getDb().prepare(`DELETE FROM dream_weaver_messages WHERE id = ?`).run(messageId);
  eventBus.emit(
    EventType.DREAM_WEAVER_MESSAGE_DELETED,
    { sessionId: existing.session_id, messageId },
    userId,
  );
}

export function markSuperseded(userId: string, messageId: string): void {
  const existing = getMessage(userId, messageId);
  if (!existing) return;
  if (existing.kind !== "tool_card") return;
  getDb()
    .prepare(`UPDATE dream_weaver_messages SET status = 'superseded' WHERE id = ?`)
    .run(messageId);
  eventBus.emit(
    EventType.DREAM_WEAVER_MESSAGE_UPDATED,
    { sessionId: existing.session_id, messageId, status: "superseded" },
    userId,
  );
}

function supersedePriorAcceptedSameTool(
  userId: string,
  sessionId: string,
  toolName: string,
  exceptMessageId: string,
): void {
  const rows = getDb()
    .prepare(`
      SELECT id FROM dream_weaver_messages
      WHERE session_id = ? AND user_id = ?
        AND kind = 'tool_card' AND tool_name = ?
        AND status = 'accepted' AND id != ?
    `)
    .all(sessionId, userId, toolName, exceptMessageId) as { id: string }[];
  for (const row of rows) markSuperseded(userId, row.id);
}

export function acceptToolCard(userId: string, messageId: string): DreamWeaverMessage {
  const existing = getMessage(userId, messageId);
  if (!existing) throw new Error("Message not found");
  if (existing.kind !== "tool_card") throw new Error("Not a tool card");
  if (existing.status !== "pending") throw new Error("Only pending cards can be accepted");

  const payload = existing.payload as unknown as ToolCardPayload;
  if (payload.error) throw new Error("Cannot accept a card with an error");

  const tool = getTool(existing.tool_name!);
  if (!tool) throw new Error(`Unknown tool: ${existing.tool_name}`);

  const updated = updateToolCard(userId, messageId, { status: "accepted" });
  if (tool.conflictMode === "overwrite") {
    supersedePriorAcceptedSameTool(userId, existing.session_id, existing.tool_name!, messageId);
  }
  return updated;
}

export function rejectToolCard(userId: string, messageId: string): DreamWeaverMessage {
  const existing = getMessage(userId, messageId);
  if (!existing) throw new Error("Message not found");
  if (existing.kind !== "tool_card") throw new Error("Not a tool card");
  if (existing.status !== "pending") throw new Error("Only pending cards can be rejected");
  return updateToolCard(userId, messageId, { status: "rejected" });
}

const workspaceCache = new Map<string, { fingerprint: string; workspace: DreamWeaverWorkspace }>();

function getWorkspaceKind(sessionId: string): DreamWeaverWorkspaceKind {
  const row = getDb()
    .prepare(`SELECT workspace_kind FROM dream_weaver_sessions WHERE id = ?`)
    .get(sessionId) as { workspace_kind?: string } | undefined;
  return row?.workspace_kind === "scenario" ? "scenario" : "character";
}

function hasSessionColumn(columnName: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pragma_table_info('dream_weaver_sessions') WHERE name = ?`)
    .get(columnName);
  return Boolean(row);
}

function legacyDraftToWorkspace(draft: DW_DRAFT_V1): DreamWeaverWorkspace {
  return {
    kind: draft.kind === "scenario" ? "scenario" : "character",
    ...EMPTY_DREAM_WEAVER_WORKSPACE,
    sources: [],
    name: draft.card?.name || draft.meta?.title || null,
    appearance: draft.card?.appearance || draft.card?.description || null,
    appearance_data: draft.card?.appearance_data ?? null,
    personality: draft.card?.personality || null,
    scenario: draft.card?.scenario || null,
    first_mes: draft.card?.first_mes || null,
    greeting: draft.greetings?.[0]?.content || null,
    voice_guidance: draft.voice_guidance ?? null,
    lorebooks: Array.isArray(draft.lorebooks) ? draft.lorebooks : [],
    npcs: Array.isArray(draft.npc_definitions) ? draft.npc_definitions : [],
  };
}

function readLegacyWorkspace(sessionId: string): DreamWeaverWorkspace | null {
  if (!hasSessionColumn("draft")) return null;
  const row = getDb()
    .prepare(`SELECT draft FROM dream_weaver_sessions WHERE id = ?`)
    .get(sessionId) as { draft?: string | null } | undefined;
  if (!row?.draft) return null;
  try {
    const parsed = JSON.parse(row.draft) as DW_DRAFT_V1;
    if (!parsed || parsed.format !== "DW_DRAFT_V1") return null;
    return legacyDraftToWorkspace(parsed);
  } catch {
    return null;
  }
}

function normalizeSource(payload: Record<string, unknown>): DreamWeaverSource | null {
  const type = payload.type === "dream" || payload.type === "note" || payload.type === "import_character" || payload.type === "import_worldbook"
    ? payload.type
    : null;
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!type || !content) return null;
  return {
    id: typeof payload.id === "string" && payload.id.trim() ? payload.id : crypto.randomUUID(),
    type,
    title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : type,
    content,
    tone: typeof payload.tone === "string" && payload.tone.trim() ? payload.tone.trim() : null,
    constraints: typeof payload.constraints === "string" && payload.constraints.trim() ? payload.constraints.trim() : null,
    dislikes: typeof payload.dislikes === "string" && payload.dislikes.trim() ? payload.dislikes.trim() : null,
  };
}

export function deriveWorkspace(userId: string, sessionId: string): DreamWeaverWorkspace {
  const fpRow = getDb()
    .prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq,
             COUNT(*) AS count,
             COALESCE(SUM(seq), 0) AS seq_sum
      FROM dream_weaver_messages
      WHERE session_id = ? AND status = 'accepted'
    `)
    .get(sessionId) as { max_seq: number; count: number; seq_sum: number };
  const fingerprint = `${fpRow.max_seq}:${fpRow.count}:${fpRow.seq_sum}`;

  const cached = workspaceCache.get(sessionId);
  if (cached && cached.fingerprint === fingerprint) return cached.workspace;

  const accepted = getDb()
    .prepare(`
      SELECT * FROM dream_weaver_messages
      WHERE session_id = ? AND user_id = ?
        AND (
          (status = 'accepted' AND kind IN ('tool_card', 'source_card'))
          OR kind = 'dream_summary'
        )
      ORDER BY seq ASC
    `)
    .all(sessionId, userId) as any[];

  if (accepted.length === 0) {
    const legacyWorkspace = readLegacyWorkspace(sessionId);
    if (legacyWorkspace) {
      workspaceCache.set(sessionId, { fingerprint, workspace: legacyWorkspace });
      return legacyWorkspace;
    }
  }

  let workspace: DreamWeaverWorkspace = {
    kind: getWorkspaceKind(sessionId),
    ...EMPTY_DREAM_WEAVER_WORKSPACE,
    sources: [],
    lorebooks: [],
    npcs: [],
  };

  for (const row of accepted) {
    if (row.kind === "source_card") {
      const source = normalizeSource(JSON.parse(row.payload));
      if (source) workspace = { ...workspace, sources: [...workspace.sources, source] };
      continue;
    }
    if (row.kind === "dream_summary") {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const source = normalizeSource({
        id: row.id,
        type: "dream",
        title: "Dream",
        content: payload.dream_text,
        tone: payload.tone,
        dislikes: payload.dislikes,
      });
      if (source) workspace = { ...workspace, sources: [...workspace.sources, source] };
      continue;
    }
    const tool = getTool(row.tool_name);
    if (!tool) continue;
    const payload = JSON.parse(row.payload) as ToolCardPayload;
    if (!payload.output) continue;
    workspace = tool.apply(workspace, payload.output);
  }

  workspaceCache.set(sessionId, { fingerprint, workspace });
  return workspace;
}

export function invalidateDraftCache(sessionId: string): void {
  workspaceCache.delete(sessionId);
}
