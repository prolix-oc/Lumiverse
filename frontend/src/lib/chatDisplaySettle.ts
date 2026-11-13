import {
  areMessageTagRuntimeInterceptorsReady,
  getMessageTagRuntimeReadinessDiagnostics,
  type MessageTagRuntimeReadinessDiagnostics,
} from './spindle/message-tag-runtime-readiness'

// Settled-state tracking for the chat reveal.
//
// On chat open, message content goes through asynchronous stages before it
// reaches its final form: Spindle extensions register message-tag
// interceptors (stripping embedded payloads like status JSON), display regex
// scripts resolve their macros and run through the worker/backend pipeline,
// and extension-owned display preprocessors rewrite content. Every stage
// repaints already-mounted rows, so revealing the chat before the pipeline
// settles shows raw tags/JSON that visibly flash away a second or two later.
//
// This module tracks the three signals the reveal gate needs:
//   - runtime tag readiness: backend-declared tag-interceptor extensions must
//     attach their frontend handlers before raw payload-bearing tags can paint.
//   - PENDING first resolves: in-flight first resolutions for the mounted
//     chat must drain before the content on screen can be trusted as final.
//   - PENDING display work: first-wave tag-intercept delivery and the
//     widget DOM inserts those handlers schedule. SimTracker (and similar
//     interceptors) rewrite row height after the registry has gone quiet;
//     revealing before those inserts finish still thrashes the list.
// The caller first mounts the warm virtual range, requires a brief zero-work
// window, then rechecks after two animation frames. That covers staged
// preprocess -> regex and tag -> widget handoffs as well as React/layout
// commits. A hard cap keeps a slow backend or stuck extension from blocking
// the reveal forever.

export const CHAT_REVEAL_SETTLE_CAP_MS = 5000

export function resetChatDisplaySettleForTests(): void {
  pendingFirstResolves.clear()
  pendingDisplayWork.clear()
}

const GLOBAL_SCOPE = '__global__'
const pendingFirstResolves = new Map<string, number>()
const pendingDisplayWork = new Map<string, number>()

type ScopedPendingDiagnostics = {
  chat: number
  global: number
  byScope: Record<string, number>
}

export type ChatDisplaySettleDiagnostics = {
  chatId: string | null
  settled: boolean
  blockers: Array<
    | 'runtime-capability-snapshot'
    | 'message-tag-interceptors'
    | 'initial-display-resolves'
    | 'display-work'
  >
  messageTagRuntime: MessageTagRuntimeReadinessDiagnostics
  pendingFirstResolves: ScopedPendingDiagnostics
  pendingDisplayWork: ScopedPendingDiagnostics
}

function scopeKey(chatId?: string | null): string {
  return chatId || GLOBAL_SCOPE
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key) ?? 0
  if (count <= 1) counts.delete(key)
  else counts.set(key, count - 1)
}

function hasPending(counts: Map<string, number>, chatId?: string | null): boolean {
  const key = scopeKey(chatId)
  return (counts.get(key) ?? 0) > 0
    || (key !== GLOBAL_SCOPE && (counts.get(GLOBAL_SCOPE) ?? 0) > 0)
}

function pendingDiagnostics(
  counts: Map<string, number>,
  chatId?: string | null,
): ScopedPendingDiagnostics {
  const key = scopeKey(chatId)
  return {
    chat: counts.get(key) ?? 0,
    global: counts.get(GLOBAL_SCOPE) ?? 0,
    byScope: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  }
}

/**
 * Count first-wave intercept delivery / widget-insert work that lands after
 * interceptor registration. Pair with `endChatDisplayWork`.
 */
export function beginChatDisplayWork(chatId?: string | null): void {
  increment(pendingDisplayWork, scopeKey(chatId))
}

export function endChatDisplayWork(chatId?: string | null): void {
  decrement(pendingDisplayWork, scopeKey(chatId))
}

/**
 * Track a first-pass resolve (one whose cache entry had no value yet). The
 * returned promise is behaviorally identical — same value, same rejection —
 * with a decrement hooked on settlement, so callers should store/await the
 * wrapped promise wherever they would have stored the original.
 */
export function trackInitialDisplayResolve<T>(promise: Promise<T>, chatId?: string | null): Promise<T> {
  const key = scopeKey(chatId)
  increment(pendingFirstResolves, key)
  return promise.finally(() => {
    decrement(pendingFirstResolves, key)
  })
}

/**
 * True when all declared tag interceptors are attached and no first resolves
 * or first-wave display work remain in flight. Resource fetching deliberately
 * does not participate: slow or unreachable image URLs must not hide a chat.
 */
export function isChatDisplaySettled(chatId?: string | null): boolean {
  if (!areMessageTagRuntimeInterceptorsReady()) return false
  if (
    hasPending(pendingFirstResolves, chatId)
    || hasPending(pendingDisplayWork, chatId)
  ) return false
  return true
}

/** Read-only snapshot emitted when a chat reveal reaches its hard settle cap. */
export function getChatDisplaySettleDiagnostics(chatId?: string | null): ChatDisplaySettleDiagnostics {
  const messageTagRuntime = getMessageTagRuntimeReadinessDiagnostics()
  const firstResolves = pendingDiagnostics(pendingFirstResolves, chatId)
  const displayWork = pendingDiagnostics(pendingDisplayWork, chatId)
  const blockers: ChatDisplaySettleDiagnostics['blockers'] = []

  if (!messageTagRuntime.snapshotReady) blockers.push('runtime-capability-snapshot')
  else if (!messageTagRuntime.ready) blockers.push('message-tag-interceptors')
  if (firstResolves.chat > 0 || firstResolves.global > 0) blockers.push('initial-display-resolves')
  if (displayWork.chat > 0 || displayWork.global > 0) blockers.push('display-work')

  return {
    chatId: chatId ?? null,
    settled: blockers.length === 0,
    blockers,
    messageTagRuntime,
    pendingFirstResolves: firstResolves,
    pendingDisplayWork: displayWork,
  }
}
