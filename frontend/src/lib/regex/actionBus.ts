import type { RegexActionEffect } from '@/types/regex'

export type ResolvedRegexActionType = 'send' | 'append' | 'effects'

export interface ResolvedRegexActionPayload {
  id: string
  type: ResolvedRegexActionType
  multi_select: boolean
  cost: number
  limit: number
  title: string
  subtitle: string
  content: string
  scriptId: string
  instanceId: string
  effects?: RegexActionEffect[]
}

export interface RegexActionActivation extends ResolvedRegexActionPayload {
  chatId: string
  messageId?: string
}

export interface PendingRegexSelection extends RegexActionActivation {
  selectedAt: number
}

export const REGEX_ACTION_EVENT = 'lumiverse:regex-action'
export const REGEX_SELECTIONS_CHANGED_EVENT = 'lumiverse:regex-action-selections-changed'
const STORAGE_PREFIX = 'lumiverse:regexActionAppend:'
const USED_STORAGE_PREFIX = 'lumiverse:regexActionUsed:'
const DRAFT_STORAGE_PREFIX = 'lumiverse:regexActionDraft:'

export interface RegexActionDraft {
  content: string
  mode: 'replace' | 'append'
}

export function applyRegexActionDraft(base: string, draft: RegexActionDraft): string {
  if (draft.mode === 'replace') return draft.content
  return [base, draft.content].filter(Boolean).join('\n\n')
}

/** Carry a one-shot draft across navigation into a newly-created branch. */
export function queueRegexActionDraft(chatId: string, draft: RegexActionDraft): void {
  try {
    sessionStorage.setItem(DRAFT_STORAGE_PREFIX + chatId, JSON.stringify(draft))
  } catch {}
}

export function consumeRegexActionDraft(chatId: string): RegexActionDraft | null {
  try {
    const key = DRAFT_STORAGE_PREFIX + chatId
    const raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RegexActionDraft>
    if (typeof parsed.content !== 'string' || (parsed.mode !== 'replace' && parsed.mode !== 'append')) return null
    return { content: parsed.content, mode: parsed.mode }
  } catch {
    return null
  }
}

function selectionKey(action: RegexActionActivation): string {
  const claimKey = action.multi_select ? `${action.instanceId}:${action.id}` : action.instanceId
  return `${action.messageId || ''}:${claimKey}`
}

function sameBlock(a: RegexActionActivation, b: RegexActionActivation): boolean {
  return a.messageId === b.messageId && a.instanceId === b.instanceId
}

function emitSelectionsChanged(chatId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(REGEX_SELECTIONS_CHANGED_EVENT, { detail: { chatId } }))
}

function isLocallyUsed(action: RegexActionActivation): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(USED_STORAGE_PREFIX + action.chatId) || '{}')
    const used = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, number> : {}
    const instanceKey = selectionKey(action)
    const blockKey = `${action.messageId || ''}:${action.instanceId}`
    return action.multi_select
      ? !!used[blockKey] || !!used[instanceKey]
      : Object.keys(used).some((key) => key === blockKey || key.startsWith(`${blockKey}:`))
  } catch {
    return true
  }
}

export function dispatchRegexAction(action: RegexActionActivation): void {
  window.dispatchEvent(new CustomEvent<RegexActionActivation>(REGEX_ACTION_EVENT, { detail: action }))
}

/** Fallback for remote multiplayer peers whose source message is host-owned. */
export function claimLocalRegexAction(action: RegexActionActivation): boolean {
  const key = USED_STORAGE_PREFIX + action.chatId
  const instanceKey = selectionKey(action)
  const blockPrefix = `${action.messageId || ''}:${action.instanceId}`
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}')
    const used = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, number> : {}
    const blockUsed = Object.keys(used).some((storedKey) => (
      storedKey === blockPrefix || storedKey.startsWith(`${blockPrefix}:`)
    ))
    if (action.multi_select ? used[blockPrefix] || used[instanceKey] : blockUsed) return false
    used[instanceKey] = Date.now()
    const entries = Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, 2000)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
    return true
  } catch {
    return false
  }
}

/** Atomically finalize a multiplayer-peer trigger and its provisional selections. */
export function claimLocalRegexActions(actions: RegexActionActivation[]): boolean {
  if (actions.length === 0) return true
  const key = USED_STORAGE_PREFIX + actions[0].chatId
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}')
    const used = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, number> : {}
    for (const action of actions) {
      const instanceKey = selectionKey(action)
      const blockKey = `${action.messageId || ''}:${action.instanceId}`
      const blockUsed = Object.keys(used).some((storedKey) => (
        storedKey === blockKey || storedKey.startsWith(`${blockKey}:`)
      ))
      if (action.multi_select ? used[blockKey] || used[instanceKey] : blockUsed) return false
    }
    const now = Date.now()
    for (const action of actions) used[selectionKey(action)] = now
    const entries = Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, 2000)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
    return true
  } catch {
    return false
  }
}

function readPending(chatId: string): PendingRegexSelection[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + chatId) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PendingRegexSelection => (
      item && typeof item === 'object' && (item.type === 'append' || item.type === 'send') &&
      typeof item.content === 'string' && typeof item.id === 'string' &&
      typeof item.scriptId === 'string' && typeof item.instanceId === 'string'
    )).map((item) => ({
      ...item,
      multi_select: item.multi_select === true,
      cost: Number.isFinite(item.cost) && item.cost > 0 ? item.cost : 1,
      limit: Number.isFinite(item.limit) && item.limit > 0 ? item.limit : 3,
    }))
  } catch {
    return []
  }
}

function writePending(chatId: string, items: PendingRegexSelection[]): void {
  try {
    if (items.length > 0) localStorage.setItem(STORAGE_PREFIX + chatId, JSON.stringify(items))
    else localStorage.removeItem(STORAGE_PREFIX + chatId)
    emitSelectionsChanged(chatId)
  } catch {}
}

export function queueRegexSelection(action: RegexActionActivation): PendingRegexSelection[] {
  const pending = readPending(action.chatId)
  const sourceKey = selectionKey(action)
  const next = pending.filter((item) => selectionKey(item) !== sourceKey)
  next.push({ ...action, selectedAt: Date.now() })
  writePending(action.chatId, next)
  return next
}

export type ToggleRegexSelectionResult =
  | { selected: true; items: PendingRegexSelection[] }
  | { selected: false; items: PendingRegexSelection[]; reason: 'removed' | 'limit' | 'invalid_limit' | 'used' }

export function toggleRegexSelection(action: RegexActionActivation): ToggleRegexSelectionResult {
  const pending = readPending(action.chatId)
  const sourceKey = selectionKey(action)
  if (pending.some((item) => selectionKey(item) === sourceKey)) {
    const next = pending.filter((item) => selectionKey(item) !== sourceKey)
    writePending(action.chatId, next)
    return { selected: false, items: next, reason: 'removed' }
  }

  if (isLocallyUsed(action)) return { selected: false, items: pending, reason: 'used' }

  if (!Number.isFinite(action.limit) || action.limit <= 0) {
    return { selected: false, items: pending, reason: 'invalid_limit' }
  }
  const blockCost = pending
    .filter((item) => item.multi_select && sameBlock(item, action))
    .reduce((total, item) => total + item.cost, 0)
  if (!Number.isFinite(action.cost) || action.cost <= 0 || blockCost + action.cost > action.limit) {
    return { selected: false, items: pending, reason: 'limit' }
  }

  const next = [...pending, { ...action, selectedAt: Date.now() }]
  writePending(action.chatId, next)
  return { selected: true, items: next }
}

export function isRegexSelectionPending(action: RegexActionActivation): boolean {
  const sourceKey = selectionKey(action)
  return readPending(action.chatId).some((item) => selectionKey(item) === sourceKey)
}

export function getRegexBlockSelectionCost(action: RegexActionActivation): number {
  return readPending(action.chatId)
    .filter((item) => item.multi_select && sameBlock(item, action))
    .reduce((total, item) => total + item.cost, 0)
}

export function hasPendingRegexSelectionsForBlock(action: RegexActionActivation): boolean {
  return readPending(action.chatId).some((item) => item.multi_select && sameBlock(item, action))
}

export function getPendingRegexSelections(chatId: string): PendingRegexSelection[] {
  return readPending(chatId)
}

export function consumeRegexSelections(chatId: string): PendingRegexSelection[] {
  const pending = readPending(chatId)
  writePending(chatId, [])
  return pending
}

export function clearRegexSelectionForSource(action: RegexActionActivation): void {
  const sourceKey = selectionKey(action)
  writePending(
    action.chatId,
    readPending(action.chatId).filter((item) => (
      action.multi_select
        ? selectionKey(item) !== sourceKey
        : item.messageId !== action.messageId || item.instanceId !== action.instanceId
    )),
  )
}

export function restoreRegexSelections(chatId: string, items: PendingRegexSelection[]): void {
  if (items.length === 0) return
  const current = readPending(chatId)
  const keys = new Set(current.map(selectionKey))
  writePending(chatId, [...current, ...items.filter((item) => !keys.has(selectionKey(item)))])
}
