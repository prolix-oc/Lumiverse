import { getDb } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverMessage,
  DreamWeaverMessageKind,
  ToolCardStatus,
  DraftV2,
  ToolCardPayload,
} from "../../types/dream-weaver";
import { EMPTY_DRAFT_V2 } from "../../types/dream-weaver";
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

const draftCache = new Map<string, { fingerprint: number; draft: DraftV2 }>();

export function deriveDraft(userId: string, sessionId: string): DraftV2 {
  const fpRow = getDb()
    .prepare(`
      SELECT COALESCE(MAX(seq), 0) AS fp
      FROM dream_weaver_messages
      WHERE session_id = ? AND status = 'accepted'
    `)
    .get(sessionId) as { fp: number };

  const cached = draftCache.get(sessionId);
  if (cached && cached.fingerprint === fpRow.fp) return cached.draft;

  const accepted = getDb()
    .prepare(`
      SELECT * FROM dream_weaver_messages
      WHERE session_id = ? AND user_id = ? AND kind = 'tool_card' AND status = 'accepted'
      ORDER BY seq ASC
    `)
    .all(sessionId, userId) as any[];

  let draft: DraftV2 = { ...EMPTY_DRAFT_V2, lorebooks: [], npcs: [] };
  for (const row of accepted) {
    const tool = getTool(row.tool_name);
    if (!tool) continue;
    const payload = JSON.parse(row.payload) as ToolCardPayload;
    if (!payload.output) continue;
    draft = tool.apply(draft, payload.output);
  }

  draftCache.set(sessionId, { fingerprint: fpRow.fp, draft });
  return draft;
}

export function invalidateDraftCache(sessionId: string): void {
  draftCache.delete(sessionId);
}
