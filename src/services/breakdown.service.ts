import { getDb } from "../db/connection";
import { getAgentRunInspection, getAgentRunInspectionForTarget } from "./agent-activity-runs.service";
import type { AgentRunInspectionDetailV1 } from "../types/agent-run-projection";


export function storeBreakdown(userId: string, messageId: string, chatId: string, data: any): void {
  const db = getDb();
  const json = typeof data === "string" ? data : JSON.stringify(data);
  db.run(
    `INSERT INTO message_breakdowns (message_id, chat_id, user_id, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET data = excluded.data, chat_id = excluded.chat_id, user_id = excluded.user_id`,
    [messageId, chatId, userId, json]
  );
}
function inspectionToBreakdown(inspection: AgentRunInspectionDetailV1): Record<string, unknown> {
  const retained = inspection.promptEvidence.filter((entry) => entry.destination !== "cortex" && entry.destination !== "council");
  const prompts = retained.some((entry) => entry.included)
    ? retained.filter((entry) => entry.included)
    : retained;
  const rootWorkInspection = inspection.promptEvidence.find((entry) => entry.destination === "root_work" && entry.loomInspection)?.loomInspection;
  const continuationInspection = inspection.promptEvidence.find((entry) => (
    (entry.destination === "completion_handoff" || entry.destination === "child_work")
    && entry.loomInspection
  ))?.loomInspection;
  const loomPromptInspection = rootWorkInspection
    ?? continuationInspection
    ?? inspection.promptEvidence.find((entry) => entry.loomInspection)?.loomInspection
    ?? null;
  const entries = prompts.map((entry) => ({
    name: entry.sourceId,
    type: "lumiverse",
    tokens: 0,
    role: entry.role === "user" || entry.role === "assistant" ? entry.role : "system",
    content: entry.content,
    blockId: entry.sourceId,
    promptOrder: entry.promptOrder,
    destination: entry.destination,
  }));
  const messages = prompts.map((entry) => ({
    role: entry.role === "user" || entry.role === "assistant" ? entry.role : "system",
    content: entry.content,
  }));
  return {
    entries,
    messages,
    totalTokens: inspection.usage.totals.totalTokens,
    chatHistoryTokens: 0,
    maxContext: 0,
    model: "recorded",
    provider: "inspection",
    parameters: {},
    usage: {
      prompt_tokens: inspection.usage.totals.inputTokens,
      completion_tokens: inspection.usage.totals.outputTokens,
      total_tokens: inspection.usage.totals.totalTokens,
    },
    tokenizer_name: null,
    assemblySurface: "WORK",
    loomPromptInspection,
    inspectionAttemptId: inspection.attempt.attemptId,
    target: inspection.target,
  };
}

function inspectionBreakdown(userId: string, messageId: string): Record<string, unknown> | null {
  const db = getDb();
  const message = db.query("SELECT m.chat_id, m.swipe_id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.user_id = ? LIMIT 1").get(messageId, userId) as { chat_id?: unknown; swipe_id?: unknown } | null;
  const swipeId = message?.swipe_id;
  if (typeof message?.chat_id !== "string" || typeof swipeId !== "number" || !Number.isSafeInteger(swipeId)) return null;
  // Resolve the inspection for this exact committed target identity. Do not
  // fall back to a chat-wide transcript or to a different swipe's attempt.
  const inspection = getAgentRunInspectionForTarget(userId, message.chat_id, messageId, swipeId);
  if (!inspection) return null;
  return inspectionToBreakdown(inspection);
}

export function getBreakdownForAttempt(userId: string, attemptId: string, chatId?: string): Record<string, unknown> | null {
  const inspection = getAgentRunInspection(userId, attemptId, chatId);
  if (!inspection) return null;
  return inspectionToBreakdown(inspection);
}


export function getBreakdown(userId: string, messageId: string): any | null {
  const db = getDb();
  const row = db.query("SELECT data FROM message_breakdowns WHERE message_id = ? AND user_id = ?").get(messageId, userId) as any;
  if (!row) return inspectionBreakdown(userId, messageId);
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function deleteBreakdownsForChat(userId: string, chatId: string): void {
  const db = getDb();
  db.run("DELETE FROM message_breakdowns WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
}
