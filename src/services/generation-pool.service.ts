/**
 * Generation Pool Service
 *
 * Maintains an in-memory buffer of accumulated generation content (tokens + reasoning)
 * per active generation. Allows clients that disconnect mid-stream to recover the
 * current state via the GET /generate/status/:chatId endpoint and resume rendering.
 *
 * Entries persist for a configurable TTL after the generation reaches a terminal state
 * (completed/stopped/error) so that reconnecting clients can discover what happened.
 */

import type { GenerationType } from "../llm/types";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

// ── Types ────────────────────────────────────────────────────────────────────

export type PoolStatus = "assembling" | "council" | "waiting" | "reasoning" | "streaming" | "completed" | "stopped" | "error";

export interface PooledTokensEntry {
  generationId: string;
  userId: string;
  chatId: string;
  content: string;
  reasoning: string;
  tokenSeq: number;
  generationType: GenerationType;
  targetMessageId?: string;
  characterName: string;
  characterId?: string;
  model: string;
  startedAt: number;
  reasoningStartedAt?: number;
  reasoningDurationMs?: number;
  status: PoolStatus;
  completedMessageId?: string;
  completedAt?: number;
  error?: string;
  /** Legacy field retained for old in-memory entries; attention is client-local. */
  acknowledged?: boolean;
  /** True while the generation is paused waiting for user to decide on failed council tools */
  councilRetryPending?: boolean;
  /** Details for a paused council retry decision so clients can recover the modal after reconnects. */
  councilToolsFailure?: {
    generationId: string;
    chatId: string;
    failedTools: {
      memberId: string;
      memberName: string;
      toolName: string;
      toolDisplayName: string;
      error?: string;
    }[];
    successCount: number;
    failedCount: number;
  };
  /** Timestamp (ms) when the LLM streaming request was initiated (post-assembly, post-council) */
  streamingStartedAt?: number;
  /** Timestamp (ms) when the first token (content or reasoning) arrived from the provider */
  firstTokenAt?: number;
  /** Timestamp (ms) when the first content token arrived (excluding reasoning) */
  firstContentTokenAt?: number;
  /** Whether this generation used streaming mode */
  wasStreaming?: boolean;
}

// ── State ────────────────────────────────────────────────────────────────────

/** Primary index: generationId → pool entry */
const pool = new Map<string, PooledTokensEntry>();

/** Secondary index: "userId:chatId" → generationId (most recent) */
const chatIndex = new Map<string, string>();

/** Terminal statuses that indicate a generation is no longer active */
const TERMINAL_STATUSES: Set<PoolStatus> = new Set(["completed", "stopped", "error"]);

/** Safety cap: terminal entries are swept after this to prevent memory leaks */
const UNACKNOWLEDGED_MAX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Additional cap so terminal chat-head state cannot grow without bound. */
const MAX_TERMINAL_ENTRIES = 200;

/** Sweep interval */
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createPoolEntry(opts: {
  generationId: string;
  userId: string;
  chatId: string;
  generationType: GenerationType;
  characterName: string;
  characterId?: string;
  model: string;
  targetMessageId?: string;
}): void {
  const entry: PooledTokensEntry = {
    generationId: opts.generationId,
    userId: opts.userId,
    chatId: opts.chatId,
    content: "",
    reasoning: "",
    tokenSeq: 0,
    generationType: opts.generationType,
    targetMessageId: opts.targetMessageId,
    characterName: opts.characterName,
    characterId: opts.characterId,
    model: opts.model,
    startedAt: Date.now(),
    status: "assembling",
  };
  pool.set(opts.generationId, entry);
  chatIndex.set(`${opts.userId}:${opts.chatId}`, opts.generationId);
}

export function setPoolStatus(generationId: string, status: PoolStatus): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = status;
}

export function markStreamingStarted(generationId: string): void {
  const entry = pool.get(generationId);
  if (entry && !entry.streamingStartedAt) {
    entry.streamingStartedAt = Date.now();
  }
}

/**
 * Append content text and increment tokenSeq.
 * Returns the new tokenSeq value (used for the `seq` field on WS events).
 */
export function appendPoolContent(generationId: string, text: string): number {
  const entry = pool.get(generationId);
  if (!entry) return 0;
  const now = Date.now();
  // Finalize reasoning duration on the first content token
  if (entry.reasoningStartedAt && !entry.reasoningDurationMs) {
    entry.reasoningDurationMs = now - entry.reasoningStartedAt;
  }
  if (!entry.firstTokenAt) entry.firstTokenAt = now;
  if (!entry.firstContentTokenAt) entry.firstContentTokenAt = now;
  if (entry.status === "assembling" || entry.status === "council" || entry.status === "waiting" || entry.status === "reasoning") {
    setPoolStatus(generationId, "streaming");
    eventBus.emit(EventType.GENERATION_PHASE_CHANGED, { generationId, chatId: entry.chatId, phase: "streaming" }, entry.userId);
  }
  entry.content += text;
  return ++entry.tokenSeq;
}

/**
 * Append reasoning text and increment tokenSeq.
 * Returns the new tokenSeq value.
 */
export function appendPoolReasoning(generationId: string, text: string): number {
  const entry = pool.get(generationId);
  if (!entry) return 0;
  const now = Date.now();
  if (!entry.reasoningStartedAt) entry.reasoningStartedAt = now;
  if (!entry.firstTokenAt) entry.firstTokenAt = now;
  if (entry.status === "assembling" || entry.status === "council" || entry.status === "waiting") {
    setPoolStatus(generationId, "reasoning");
    eventBus.emit(EventType.GENERATION_PHASE_CHANGED, { generationId, chatId: entry.chatId, phase: "reasoning" }, entry.userId);
  }
  entry.reasoning += text;
  return ++entry.tokenSeq;
}

export function completePool(generationId: string, messageId: string | undefined): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "completed";
  entry.completedMessageId = messageId;
  entry.completedAt = Date.now();
  trimTerminalEntries();
}

export function stopPool(generationId: string): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "stopped";
  entry.completedAt = Date.now();
  trimTerminalEntries();
}

export function errorPool(generationId: string, message: string): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "error";
  entry.error = message;
  entry.completedAt = Date.now();
  trimTerminalEntries();
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export function getPoolEntry(generationId: string): PooledTokensEntry | undefined {
  return pool.get(generationId);
}

/**
 * Look up the most recent pool entry for a chat. Returns the entry if it
 * exists and belongs to the given user. Covers both active and recently-
 * completed (within TTL) entries.
 */
export function getPoolForChat(userId: string, chatId: string): PooledTokensEntry | undefined {
  const chatKey = `${userId}:${chatId}`;
  const generationId = chatIndex.get(chatKey);
  if (!generationId) return undefined;
  const entry = pool.get(generationId);
  if (!entry || entry.userId !== userId) return undefined;
  return entry;
}

/**
 * Return all active (non-terminal) pool entries for a user.
 * Used by the chat heads overlay to show in-progress generations across chats.
 */
export function getActivePoolsForUser(userId: string): PooledTokensEntry[] {
  const results: PooledTokensEntry[] = [];
  for (const entry of pool.values()) {
    if (entry.userId === userId && !TERMINAL_STATUSES.has(entry.status)) {
      results.push(entry);
    }
  }
  return results;
}

/**
 * Return the latest pooled entry per chat that the user should see as a chat
 * head. Older generations for the same chat are intentionally hidden.
 */
export function getChatHeadPoolsForUser(userId: string): PooledTokensEntry[] {
  const results: PooledTokensEntry[] = [];
  for (const generationId of chatIndex.values()) {
    const entry = pool.get(generationId);
    if (!entry || entry.userId !== userId) continue;
    results.push(entry);
  }
  return results;
}

/**
 * Clear terminal chat-head state for a chat once a user actually opens it.
 * Active generations are preserved so streaming recovery still works.
 */
export function acknowledgeChat(userId: string, chatId: string): string[] {
  const currentGenerationId = chatIndex.get(`${userId}:${chatId}`);
  if (currentGenerationId) {
    const currentEntry = pool.get(currentGenerationId);
    if (currentEntry && !TERMINAL_STATUSES.has(currentEntry.status)) {
      return [];
    }
  }

  const removed: string[] = [];
  for (const [generationId, entry] of pool) {
    if (entry.userId !== userId || entry.chatId !== chatId) continue;
    if (!TERMINAL_STATUSES.has(entry.status)) continue;
    removed.push(generationId);
  }
  for (const generationId of removed) {
    removePoolEntry(generationId);
  }
  return removed;
}

export function clearAllPoolEntries(): void {
  pool.clear();
  chatIndex.clear();
}

export function removePoolEntry(generationId: string): void {
  const entry = pool.get(generationId);
  if (entry) {
    const chatKey = `${entry.userId}:${entry.chatId}`;
    // Only clear the chat index if it still points to this generation
    if (chatIndex.get(chatKey) === generationId) {
      chatIndex.delete(chatKey);
    }
  }
  pool.delete(generationId);
}

/**
 * Remove all pool entries for a given chat. Called when a chat is deleted
 * so that stale entries don't linger as phantom chat heads.
 */
export function removePoolEntriesForChat(userId: string, chatId: string): void {
  const chatKey = `${userId}:${chatId}`;
  for (const [id, entry] of pool) {
    if (entry.userId === userId && entry.chatId === chatId) {
      pool.delete(id);
    }
  }
  chatIndex.delete(chatKey);
}

// ── Sweep ────────────────────────────────────────────────────────────────────

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of pool) {
    if (!TERMINAL_STATUSES.has(entry.status) || !entry.completedAt) continue;
    const age = now - entry.completedAt;
    const ttl = UNACKNOWLEDGED_MAX_TTL_MS;
    if (age > ttl) {
      removePoolEntry(id);
    }
  }

  trimTerminalEntries();
}

function trimTerminalEntries(): void {
  const terminalEntries = [...pool.entries()]
    .filter(([, entry]) => TERMINAL_STATUSES.has(entry.status) && entry.completedAt)
    .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));

  while (terminalEntries.length > MAX_TERMINAL_ENTRIES) {
    const [generationId] = terminalEntries.shift()!;
    removePoolEntry(generationId);
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startPoolSweep(): void {
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  }
}

export function stopPoolSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Auto-start sweep on module load
startPoolSweep();
