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
  requestAuthorityId?: string;
  tokenSeq: number;
  generationType: GenerationType;
  targetMessageId?: string;
  /** Index of the swipe being streamed into, so recovering clients can gate the
   *  streaming buffer to the right swipe even after navigating away. */
  targetSwipeId?: number;
  characterName: string;
  characterId?: string;
  model: string;
  provider?: string;
  connectionId?: string;
  startedAt: number;
  reasoningStartedAt?: number;
  reasoningDurationMs?: number;
  status: PoolStatus;
  /** Timestamp (ms) of the last append/status transition. Drives the stale
   *  non-terminal failsafe so hung generations don't leak pool entries. */
  lastActivityAt: number;
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

/** Terminal reasons understood by the shared generation owner. */
export type PoolTerminalReason = "completed" | "stopped" | "failed" | "timeout";

export interface PoolTerminalProjection {
  readonly status: Extract<PoolStatus, "completed" | "stopped" | "error">;
  readonly messageId?: string;
  readonly error?: string;
}

/**
 * A generation owns terminal compare-and-set through its AgentTurnLedger.
 * The pool is only a projection: it asks the owner to claim, then records the
 * winning terminal snapshot. Feature-inactive generations use the same
 * interface with a small compatible CAS coordinator.
 */
export interface PoolTerminalOwner {
  tryTerminate(reason: PoolTerminalReason): boolean;
  projectTerminal: (projection: PoolTerminalProjection) => boolean;
}

/** Primary index: generationId → pool entry */
const pool = new Map<string, PooledTokensEntry>();

/** Secondary index: "userId:chatId" → generationId (most recent) */
const chatIndex = new Map<string, string>();

/** Terminal owner per generation. The owner, not this service, owns CAS. */
const terminalOwners = new Map<string, PoolTerminalOwner>();

/** Terminal statuses that indicate a generation is no longer active */
const TERMINAL_STATUSES: Set<PoolStatus> = new Set(["completed", "stopped", "error"]);

/** Safety cap: terminal entries are swept after this to prevent memory leaks */
const UNACKNOWLEDGED_MAX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Failsafe: a non-terminal entry with no pool activity (no tokens, no status
 * transitions) for this long is force-errored. Without it, a generation that
 * hangs without ever reaching a terminal state leaks its entry and leaves the
 * chat showing "streaming" forever. Generous because slow local models can
 * legitimately sit in prompt processing for many minutes without emitting.
 */
const STALE_ACTIVE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/** Additional cap so terminal chat-head state cannot grow without bound. */
const MAX_TERMINAL_ENTRIES = 200;

/** Sweep interval */
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createPoolEntry(opts: {
  generationId: string;
  userId: string;
  chatId: string;
  requestAuthorityId?: string;
  generationType: GenerationType;
  characterName: string;
  characterId?: string;
  model: string;
  provider?: string;
  connectionId?: string;
  targetMessageId?: string;
  targetSwipeId?: number;
}): void {
  const entry: PooledTokensEntry = {
    generationId: opts.generationId,
    userId: opts.userId,
    chatId: opts.chatId,
    requestAuthorityId: opts.requestAuthorityId,
    content: "",
    reasoning: "",
    tokenSeq: 0,
    generationType: opts.generationType,
    targetMessageId: opts.targetMessageId,
    targetSwipeId: opts.targetSwipeId,
    characterName: opts.characterName,
    characterId: opts.characterId,
    model: opts.model,
    provider: opts.provider,
    connectionId: opts.connectionId,
    startedAt: Date.now(),
    status: "assembling",
    lastActivityAt: Date.now(),
  };
  pool.set(opts.generationId, entry);
  chatIndex.set(`${opts.userId}:${opts.chatId}`, opts.generationId);
}
/** Register the ledger-backed terminal owner after the pool entry exists. */
export function registerPoolTerminalOwner(
  generationId: string,
  owner: PoolTerminalOwner,
): void {
  terminalOwners.set(generationId, owner);
}

/** Detach terminal callbacks after the generation has fully torn down. */
export function unregisterPoolTerminalOwner(generationId: string): void {
  terminalOwners.delete(generationId);
}

export function setPoolStatus(generationId: string, status: PoolStatus): void {
  const entry = pool.get(generationId);
  if (!entry || TERMINAL_STATUSES.has(entry.status)) return;
  entry.status = status;
  entry.lastActivityAt = Date.now();
}

export function markStreamingStarted(generationId: string): void {
  const entry = pool.get(generationId);
  if (entry && !TERMINAL_STATUSES.has(entry.status) && !entry.streamingStartedAt) {
    entry.streamingStartedAt = Date.now();
  }
}

/** Result of a pool append: seq for legacy consumers (Spindle extensions),
 *  offset = char position of the appended text within the cumulative buffer.
 *  Offsets give clients exact dedupe/gap detection across recovery snapshots. */
export interface PoolAppendResult {
  seq: number;
  offset: number;
}

/**
 * Append content text and increment tokenSeq.
 * Returns the new tokenSeq value (used for the `seq` field on WS events) and
 * the char offset where this text begins in the cumulative content buffer.
 */
export function appendPoolContent(generationId: string, text: string): PoolAppendResult {
  const entry = pool.get(generationId);
  if (!entry) return { seq: 0, offset: 0 };
  if (TERMINAL_STATUSES.has(entry.status)) {
    return { seq: entry.tokenSeq, offset: entry.content.length };
  }
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
  const offset = entry.content.length;
  entry.content += text;
  entry.lastActivityAt = now;
  return { seq: ++entry.tokenSeq, offset };
}

/**
 * Append reasoning text and increment tokenSeq.
 * Returns the new tokenSeq value and the char offset where this text begins
 * in the cumulative reasoning buffer.
 */
export function appendPoolReasoning(generationId: string, text: string): PoolAppendResult {
  const entry = pool.get(generationId);
  if (!entry) return { seq: 0, offset: 0 };
  if (TERMINAL_STATUSES.has(entry.status)) {
    return { seq: entry.tokenSeq, offset: entry.reasoning.length };
  }
  const now = Date.now();
  if (!entry.firstTokenAt) entry.firstTokenAt = now;
  if (entry.status === "assembling" || entry.status === "council" || entry.status === "waiting") {
    setPoolStatus(generationId, "reasoning");
    eventBus.emit(EventType.GENERATION_PHASE_CHANGED, { generationId, chatId: entry.chatId, phase: "reasoning" }, entry.userId);
  }
  const offset = entry.reasoning.length;
  entry.reasoning += text;
  entry.lastActivityAt = now;
  return { seq: ++entry.tokenSeq, offset };
}
function terminalReasonForStatus(
  status: PoolTerminalProjection["status"],
): PoolTerminalReason {
  return status === "completed"
    ? "completed"
    : status === "stopped"
      ? "stopped"
      : "failed";
}

/**
 * Record the terminal projection after the shared owner wins CAS.
 * This function intentionally never calls the owner and therefore cannot
 * recurse when the owner is notified by requestPoolTerminal.
 */
export function projectPoolTerminal(
  generationId: string,
  projection: PoolTerminalProjection,
): boolean {
  const entry = pool.get(generationId);
  if (!entry || TERMINAL_STATUSES.has(entry.status)) return false;
  entry.status = projection.status;
  if (projection.messageId !== undefined) {
    entry.completedMessageId = projection.messageId;
  }
  if (projection.error !== undefined) entry.error = projection.error;
  entry.completedAt = Date.now();
  entry.lastActivityAt = entry.completedAt;
  trimTerminalEntries();
  return true;
}

function requestPoolTerminal(
  generationId: string,
  projection: PoolTerminalProjection,
  reason = terminalReasonForStatus(projection.status),
): boolean {
  const owner = terminalOwners.get(generationId);
  if (owner && !owner.tryTerminate(reason)) return false;
  if (owner) return owner.projectTerminal(projection);
  const projected = projectPoolTerminal(generationId, projection);
  return projected;
}

export function completePool(
  generationId: string,
  messageId: string | undefined,
): void {
  requestPoolTerminal(generationId, {
    status: "completed",
    ...(messageId !== undefined ? { messageId } : {}),
  });
}

export function stopPool(generationId: string): void {
  requestPoolTerminal(generationId, { status: "stopped" });
}

export function errorPool(generationId: string, message: string): void {
  requestPoolTerminal(generationId, { status: "error", error: message });
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
  terminalOwners.clear();
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
  terminalOwners.delete(generationId);
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
      terminalOwners.delete(id);
      pool.delete(id);
    }
  }
  chatIndex.delete(chatKey);
}

// ── Sweep ────────────────────────────────────────────────────────────────────

function sweep(): void {
  const now = Date.now();

  // Failsafe: force-error non-terminal entries with no activity for far longer
  // than any legitimate generation gap. The terminal owner is asked first, so
  // a late provider completion cannot overwrite a watchdog winner.
  for (const entry of pool.values()) {
    if (TERMINAL_STATUSES.has(entry.status)) continue;
    if (now - entry.lastActivityAt <= STALE_ACTIVE_TIMEOUT_MS) continue;
    const message = "Generation timed out: no activity for 60 minutes";
    const priorStatus = entry.status;
    const owner = terminalOwners.get(entry.generationId);
    const projected = requestPoolTerminal(
      entry.generationId,
      { status: "error", error: message },
      "timeout",
    );
    if (projected && !owner) {
      eventBus.emit(
        EventType.GENERATION_ENDED,
        { generationId: entry.generationId, chatId: entry.chatId, error: message },
        entry.userId,
      );
    }
    if (!projected) continue;
    console.warn(
      `[GenerationPool] Force-errored stale generation ${entry.generationId} (chat ${entry.chatId}, status was ${priorStatus})`,
    );
  }

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

/** Run one sweep pass immediately (stale failsafe + terminal TTL/trim). */
export function sweepPoolNow(): void {
  sweep();
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
