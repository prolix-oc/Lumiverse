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

// ── Types ────────────────────────────────────────────────────────────────────

export type PoolStatus = "assembling" | "council" | "streaming" | "completed" | "stopped" | "error";

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
  /** Whether the user has acknowledged (viewed) a terminal generation */
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

/** TTL for acknowledged terminal entries before cleanup */
const TERMINAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Safety cap: unacknowledged entries are swept after this to prevent memory leaks */
const UNACKNOWLEDGED_MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  if (status === "streaming" && !entry.streamingStartedAt) {
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
  entry.reasoning += text;
  return ++entry.tokenSeq;
}

export function completePool(generationId: string, messageId: string): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "completed";
  entry.completedMessageId = messageId;
  entry.completedAt = Date.now();
}

export function stopPool(generationId: string): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "stopped";
  entry.completedAt = Date.now();
}

export function errorPool(generationId: string, message: string): void {
  const entry = pool.get(generationId);
  if (!entry) return;
  entry.status = "error";
  entry.error = message;
  entry.completedAt = Date.now();
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
 * Return all entries the user should see as chat heads:
 * active generations + terminal ones not yet acknowledged.
 */
export function getChatHeadPoolsForUser(userId: string): PooledTokensEntry[] {
  const results: PooledTokensEntry[] = [];
  for (const entry of pool.values()) {
    if (entry.userId !== userId) continue;
    if (!TERMINAL_STATUSES.has(entry.status) || !entry.acknowledged) {
      results.push(entry);
    }
  }
  return results;
}

/**
 * Mark all terminal entries for a chat as acknowledged.
 * Called when the user navigates to the chat or clicks the chat head.
 */
export function acknowledgeChat(userId: string, chatId: string): void {
  for (const entry of pool.values()) {
    if (entry.userId === userId && entry.chatId === chatId && TERMINAL_STATUSES.has(entry.status)) {
      entry.acknowledged = true;
    }
  }
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
    // Acknowledged entries use the short TTL; unacknowledged get the safety cap
    const ttl = entry.acknowledged ? TERMINAL_TTL_MS : UNACKNOWLEDGED_MAX_TTL_MS;
    if (age > ttl) {
      removePoolEntry(id);
    }
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
