import type { ActivatedWorldInfoEntry } from '../../types/api'
import type { LoreIndicatorSettings } from '../../types/store'

export interface LorePoint {
  x: number
  y: number
}

export interface LoreRect extends LorePoint {
  width: number
  height: number
}

export interface LoreActivationContext {
  exactTriggerPhrase: string | null
  matchedPrimaryKeys: string[]
  matchedSecondaryKeys: string[]
  configuredPrimaryKeys: string[]
  matchedBecause: string | null
  matchedContentPreview: string | null
  whyActivated: string | null
  triggeringExcerpt: string | null
}

export const LORE_ITEM_IDS = [
  'active-count',
  'token-estimate',
  'passes',
  'constant',
  'keyword',
  'vector',
  'lorebooks',
  'search',
  'grouping',
] as const

export type LoreItemId = typeof LORE_ITEM_IDS[number]

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
  }
  const single = firstString(value)
  return single ? [single] : []
}

export function formatCompactNumber(value: unknown): string {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (normalized < 1_000) return String(normalized)
  if (normalized < 1_000_000) return `${(normalized / 1_000).toFixed(normalized >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return `${(normalized / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function getExactTriggerPhrase(entry: ActivatedWorldInfoEntry): string | null {
  return firstString(
    entry.triggerPhrase,
    entry.matchedPhrase,
    entry.matchedKey,
    entry.matchedTrigger,
    entry.trigger,
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split scanned text into sentences. Keeps quoted dialogue together and treats
 * hard line breaks as boundaries, which is how roleplay messages read.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?…]["'”’)\]]?)\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * Locate the single sentence a key actually matched in.
 *
 * The activation payload carries no trigger phrase or excerpt, so the panel used
 * to fall back to the entire generation query — printing the whole message under
 * "triggering sentence". Deriving the sentence here keeps that field honest.
 */
export function findTriggeringSentence(
  sourceText: string | null | undefined,
  phrases: string[],
): { sentence: string; phrase: string } | null {
  if (!sourceText?.trim()) return null
  const candidates = phrases.map((phrase) => phrase.trim()).filter(Boolean)
  if (candidates.length === 0) return null

  for (const sentence of splitSentences(sourceText)) {
    for (const phrase of candidates) {
      // Word-boundary match where the key is word-like, substring otherwise, so
      // regex-style and punctuation keys still resolve.
      const pattern = /^[\w\s'-]+$/.test(phrase)
        ? new RegExp(`(^|[^\\w])${escapeRegExp(phrase)}([^\\w]|$)`, 'i')
        : new RegExp(escapeRegExp(phrase), 'i')
      if (pattern.test(sentence)) return { sentence, phrase }
    }
  }
  return null
}

/**
 * Builds the corpus the activation scan actually ran against.
 *
 * `activatedWorldInfo` is emitted while the prompt is assembled, so by the time the
 * panel renders, the chat already contains the reply that activation produced.
 * Including it would let a key match text that was never scanned and report it as
 * the trigger, so trailing non-user messages are dropped.
 */
export function buildLoreScanText(
  queryPreview: string | null | undefined,
  messages: Array<{ content: string; is_user: boolean }>,
  historyDepth = 4,
): string {
  let end = messages.length
  while (end > 0 && !messages[end - 1].is_user) end -= 1
  const scanned = messages.slice(Math.max(0, end - historyDepth), end)
  return [queryPreview ?? '', ...scanned.map((message) => message.content)]
    .filter(Boolean)
    .join('\n')
}

/** Last sentence of the scanned text — the closest thing a vector hit has to a trigger. */
export function getLastScannedSentence(sourceText: string | null | undefined): string | null {
  if (!sourceText?.trim()) return null
  return splitSentences(sourceText).at(-1) ?? null
}

export function getActivationContext(
  entry: ActivatedWorldInfoEntry,
  sourceText?: string | null,
): LoreActivationContext {
  const reportedPhrase = getExactTriggerPhrase(entry)
  const reportedPrimaryKeys = stringList(entry.matchedPrimaryKeys ?? entry.matchedKey)
  const configuredPrimaryKeys = stringList(entry.keys)
  const reportedExcerpt = firstString(entry.triggeringSentence, entry.messageExcerpt, entry.contextExcerpt)

  const derived = entry.activationType === 'keyword' && !reportedExcerpt
    ? findTriggeringSentence(sourceText, reportedPhrase ? [reportedPhrase, ...configuredPrimaryKeys] : configuredPrimaryKeys)
    : null

  return {
    exactTriggerPhrase: reportedPhrase ?? derived?.phrase ?? null,
    matchedPrimaryKeys: reportedPrimaryKeys.length > 0
      ? reportedPrimaryKeys
      : derived ? [derived.phrase] : [],
    matchedSecondaryKeys: stringList(entry.matchedSecondaryKeys),
    configuredPrimaryKeys,
    matchedBecause: firstString(entry.matchedBecause, entry.matchReason),
    matchedContentPreview: firstString(entry.matchedContentPreview, entry.contentPreview),
    whyActivated: firstString(entry.whyActivated),
    triggeringExcerpt: reportedExcerpt ?? derived?.sentence ?? null,
  }
}

export function clampLoreFloatingPosition(
  point: LorePoint,
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 12,
): LorePoint {
  return {
    x: Math.min(Math.max(margin, point.x), Math.max(margin, viewport.width - surface.width - margin)),
    y: Math.min(Math.max(margin, point.y), Math.max(margin, viewport.height - surface.height - margin)),
  }
}

export function clampLoreRect(
  rect: LoreRect,
  viewport: { width: number; height: number },
  minimum = { width: 560, height: 360 },
  margin = 16,
): LoreRect {
  const width = Math.min(Math.max(minimum.width, rect.width), Math.max(minimum.width, viewport.width - margin * 2))
  const height = Math.min(Math.max(minimum.height, rect.height), Math.max(minimum.height, viewport.height - margin * 2))
  return {
    width,
    height,
    x: Math.min(Math.max(margin, rect.x), Math.max(margin, viewport.width - width - margin)),
    y: Math.min(Math.max(margin, rect.y), Math.max(margin, viewport.height - height - margin)),
  }
}

export function getFloatingPanelPosition(
  anchor: LorePoint,
  control: { width: number; height: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 12,
  gap = 8,
): LorePoint {
  const preferredTop = anchor.y + control.height + gap
  const top = preferredTop + panel.height <= viewport.height - margin
    ? preferredTop
    : anchor.y - panel.height - gap
  return clampLoreFloatingPosition(
    { x: anchor.x, y: top },
    panel,
    viewport,
    margin,
  )
}

export function clampLorePanelHeight(height: number, viewportHeight: number, margin = 42): number {
  const maxHeight = Math.max(320, viewportHeight - margin * 2)
  return Math.min(Math.max(320, height), maxHeight)
}

export function getConfiguredV4Items(settings: LoreIndicatorSettings) {
  const existing = new Map(settings.v4Items.map((item) => [item.id, item]))
  return LORE_ITEM_IDS.map((id, index) => existing.get(id) ?? {
    id,
    visible: true,
    removed: false,
    mode: 'iconText' as const,
    order: index,
  }).sort((a, b) => a.order - b.order)
}

export function matchesKeybind(event: KeyboardEvent, keybind: string): boolean {
  const parts = keybind.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return false
  const key = parts.at(-1)
  if (!key || event.key.toLowerCase() !== key) return false
  return (
    event.ctrlKey === parts.includes('ctrl') &&
    event.metaKey === parts.includes('meta') &&
    event.altKey === parts.includes('alt') &&
    event.shiftKey === parts.includes('shift')
  )
}

export function searchLoreEntries(entries: ActivatedWorldInfoEntry[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return entries
  return entries.filter((entry) => {
    const context = getActivationContext(entry)
    return [
      entry.comment,
      entry.bookName,
      entry.bookId,
      entry.activationType,
      entry.source,
      entry.keys.join(' '),
      context.exactTriggerPhrase,
      context.matchedPrimaryKeys.join(' '),
      context.matchedSecondaryKeys.join(' '),
      context.matchedBecause,
      context.matchedContentPreview,
      context.whyActivated,
      context.triggeringExcerpt,
      entry.score?.toString(),
      entry.priority.toString(),
    ].some((value) => value?.toLowerCase().includes(normalized))
  })
}
