import type { SuiteHostContext, SuiteModule, SuiteModuleContext } from '../../suite'
import { buildSettingPath, requireSuiteSettings, type SuiteSettingsAPI } from '../../shared/settings'
import {
  bookIdFromScopedRow,
  ownerDocumentOf,
  readExtensionInstallationId,
  type ScopedHostRoot,
} from '../../shared/public-sdk'
import type { LorebookTokenCountUpdatedPayload } from './types'

const MODULE_ID = 'lorebook_token_counts' as const
export const LOREBOOK_TOKEN_COUNTS_ENABLED_KEY = buildSettingPath(MODULE_ID, 'enabled')
const ROW_DECORATOR_TARGET = '[data-world-book-entry-row]'
const BADGE_SELECTOR = '[data-lumiverse-token-count-badge]'
const NATIVE_CELL_SELECTOR = '[data-world-book-token-cell]'
const MAX_BATCH_SIZE = 64


const MODULE_STYLES = String.raw`
[data-lumiverse-module="lorebook_token_counts"][data-lumiverse-token-count-badge]{align-items:center;background:var(--lumiverse-fill-medium,rgba(127,127,127,.14));border:1px solid var(--lumiverse-border,rgba(127,127,127,.28));border-radius:999px;color:var(--lumiverse-text-muted,currentColor);display:inline-flex;font:600 .75rem/1 system-ui;justify-content:center;margin-inline-start:6px;min-height:24px;min-width:48px;padding:3px 7px;white-space:nowrap}
[data-lumiverse-module="lorebook_token_counts"][data-state="counting"]{opacity:.72}
[data-lumiverse-module="lorebook_token_counts"][data-state="error"]{color:var(--lumiverse-danger,#dc4c64)}
`

type JsonRecord = Record<string, unknown>

interface EntrySnapshot {
  readonly id: string
  readonly content: string
  readonly updatedAt?: string
  readonly revision?: string
}


interface CountResult {
  readonly count: number
  readonly approximate: boolean
  readonly model?: string
}
interface CountItem {
  readonly row: ScopedHostRoot
  readonly badge: HTMLElement
  readonly bookId: string
  readonly entry: EntrySnapshot
  readonly version: string
}

interface CountWork {
  readonly key: string
  readonly identity: string
  readonly version: string
  readonly text: string
  readonly promise: Promise<CountResult>
  readonly resolve: (result: CountResult) => void
  readonly reject: (error: unknown) => void
}

interface CachedCount {
  readonly version: string
  readonly result: CountResult
}

interface DecoratedRow {
  readonly row: ScopedHostRoot
  readonly bookId: string
  readonly entryId: string
}


function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
function versionPart(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}


function entrySnapshot(value: unknown): EntrySnapshot | undefined {
  if (!isRecord(value)) return undefined
  const id = nonEmptyString(value.id ?? value.uid ?? value.entryId)
  if (!id || typeof value.content !== 'string') return undefined
  const updatedAt = versionPart(value.updated_at) ?? versionPart(value.updatedAt)
  const revision = versionPart(value.revision)
  return {
    id,
    content: value.content,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(revision === undefined ? {} : { revision }),
  }
}

function countResult(value: unknown): CountResult | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value.total_tokens ?? value.token_count ?? value.count
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || !Number.isInteger(candidate)) return undefined
  return {
    count: candidate,
    approximate: value.approximate === true,
    model: nonEmptyString(value.model),
  }
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function ownedBadge(node: Element, uuid: string | undefined): node is HTMLElement {
  const element = node as HTMLElement
  if (!uuid) return element.getAttribute('data-lumiverse-module') === MODULE_ID
  return element.getAttribute('data-spindle-extension-root') === uuid
    || element.getAttribute('data-spindle-ext') === uuid
}

function renderBadge(badge: HTMLElement, result: CountResult): void {
  const text = `${result.approximate ? '~' : ''}${result.count.toLocaleString()}`
  if (badge.textContent !== text) badge.textContent = text
  badge.dataset.state = 'ready'
  badge.dataset.approximate = result.approximate ? 'true' : 'false'
  badge.setAttribute('aria-label', `${result.approximate ? 'Approximately ' : ''}${result.count.toLocaleString()} tokens`)
}

async function listBookEntries(host: SuiteHostContext, bookId: string): Promise<readonly unknown[]> {
  const listed = await host.worldBooks?.entries.list(bookId)
  return listed?.data ?? []
}

export function createLorebookTokenCountsModule(): SuiteModule {
  let context: SuiteModuleContext | undefined
  let settings: SuiteSettingsAPI | undefined
  let running = false
  let enabled = true
  let generation = 0
  let reconcileSerial = 0
  let decoratorHandle: { destroy(): void } | undefined
  let stopSettingsWatch: (() => void) | undefined
  let stopCountUpdates: (() => void) | undefined
  let reconcileQueued = false
  let stylesActive = false
  const decoratedRows = new Map<ScopedHostRoot, DecoratedRow>()
  const activeCounts = new Map<string, Promise<CountResult>>()
  const cachedCounts = new Map<string, CachedCount>()
  const latestVersions = new Map<string, { readonly version: string; readonly serial: number }>()

  const isCurrent = (expected: number): boolean => running && enabled && generation === expected
  const countIdentity = (bookId: string, entryId: string): string => `${bookId}:${entryId}`

  const updateFromBus = (payload: LorebookTokenCountUpdatedPayload): void => {
    if (!running || !enabled) return
    for (const decorated of decoratedRows.values()) {
      if (decorated.bookId !== payload.bookId || decorated.entryId !== payload.entryId) continue
      const badge = decorated.row.querySelector<HTMLElement>(BADGE_SELECTOR)
      if (!badge) continue
      renderBadge(badge, payload)
      const version = badge.dataset.fingerprint
      if (version) cachedCounts.set(countIdentity(payload.bookId, payload.entryId), { version, result: payload })
    }
  }

  const ensureBadge = (row: ScopedHostRoot, bookId: string, entryId: string, uuid: string | undefined): HTMLElement => {
    const existing = row.querySelector<HTMLElement>(BADGE_SELECTOR)
    if (existing && ownedBadge(existing, uuid)) {
      existing.dataset.bookId = bookId
      existing.dataset.entryId = entryId
      return existing
    }
    const doc = ownerDocumentOf(row)
    if (!doc) throw new Error('TOKEN_COUNT_OWNER_DOCUMENT_UNAVAILABLE')
    const badge = doc.createElement('span')
    badge.dataset.lumiverseTokenCountBadge = 'true'
    badge.dataset.lumiverseModule = MODULE_ID
    badge.dataset.bookId = bookId
    badge.dataset.entryId = entryId
    badge.dataset.state = 'counting'
    badge.textContent = '...'
    badge.setAttribute('role', 'status')
    badge.setAttribute('aria-label', 'Counting tokens')
    if (uuid) {
      badge.dataset.spindleExtensionRoot = uuid
      badge.dataset.spindleExt = uuid
    }
    row.append(badge)
    context?.bus?.emit('tokens/refresh-requested', { bookId, entryId })
    return badge
  }


  const entryVersion = (entry: EntrySnapshot, rowRevision: string | undefined): string => {
    const revision = versionPart(rowRevision) ?? entry.revision
    const base = entry.updatedAt === undefined
      ? `content:${entry.content.length}:${fnv1a32(entry.content)}`
      : `updated:${entry.updatedAt}`
    return revision === undefined ? base : `${base}:revision:${revision}`
  }

  const cachedResult = (identity: string, version: string): CountResult | undefined => {
    const cached = cachedCounts.get(identity)
    if (!cached) return undefined
    if (cached.version !== version) {
      cachedCounts.delete(identity)
      return undefined
    }
    return cached.result
  }

  const applyResult = (
    item: CountItem,
    result: CountResult,
    activeContext: SuiteModuleContext,
    expected: number,
    emit: boolean,
  ): void => {
    if (!isCurrent(expected) || !item.row.isConnected || item.badge.dataset.fingerprint !== item.version) return
    renderBadge(item.badge, result)
    if (!emit) return
    activeContext.bus?.emit('tokens/count-updated', {
      bookId: item.bookId,
      entryId: item.entry.id,
      count: result.count,
      approximate: result.approximate,
      model: result.model,
    })
  }

  const applyError = (
    item: CountItem,
    expected: number,
  ): void => {
    if (!isCurrent(expected) || !item.row.isConnected || item.badge.dataset.fingerprint !== item.version) return
    item.badge.dataset.state = 'error'
    item.badge.textContent = '—'
    item.badge.setAttribute('aria-label', 'Token count unavailable')
  }

  const attachWork = (
    promise: Promise<CountResult>,
    item: CountItem,
    activeContext: SuiteModuleContext,
    expected: number,
    emit: boolean,
  ): void => {
    void promise.then((result) => {
      applyResult(item, result, activeContext, expected, emit)
    }).catch(() => {
      applyError(item, expected)
    })
  }

  const yieldBetweenBatches = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    return promise
  }

  const reconcile = async (expected: number, serial: number): Promise<void> => {
    const activeContext = context
    if (!activeContext || !isCurrent(expected)) return
    const groups = new Map<string, DecoratedRow[]>()
    const uuid = readExtensionInstallationId(activeContext.host)
    for (const decorated of decoratedRows.values()) {
      const native = decorated.row.querySelector(NATIVE_CELL_SELECTOR)
      const owned = decorated.row.querySelector<HTMLElement>(BADGE_SELECTOR)
      if (native) {
        if (owned && ownedBadge(owned, uuid)) owned.remove()
        continue
      }
      const rows = groups.get(decorated.bookId) ?? []
      rows.push(decorated)
      groups.set(decorated.bookId, rows)
    }

    for (const [bookId, rows] of groups) {
      let values: readonly unknown[]
      try {
        values = await listBookEntries(activeContext.host, bookId)
      } catch {
        continue
      }
      if (!isCurrent(expected)) return
      const entries = new Map<string, EntrySnapshot>()
      for (const value of values) {
        const entry = entrySnapshot(value)
        if (entry) entries.set(entry.id, entry)
      }

      const workItems = new Map<string, CountWork>()
      for (const decorated of rows) {
        if (!isCurrent(expected) || !decorated.row.isConnected) continue
        const entry = entries.get(decorated.entryId)
        if (!entry) continue
        const badge = ensureBadge(decorated.row, bookId, entry.id, uuid)
        const identity = countIdentity(bookId, entry.id)
        const version = entryVersion(entry, decorated.row.dataset.worldBookEntryRevision)
        const workKey = `${identity}:${version}`
        const latest = latestVersions.get(identity)
        if (!latest || serial >= latest.serial) latestVersions.set(identity, { version, serial })

        if (badge.dataset.fingerprint === version && badge.dataset.state === 'ready') continue
        badge.dataset.fingerprint = version
        badge.dataset.state = 'counting'
        badge.textContent = '...'
        const cached = cachedResult(identity, version)
        if (cached) {
          renderBadge(badge, cached)
          continue
        }

        const existing = activeCounts.get(workKey)
        const item: CountItem = { row: decorated.row, badge, bookId, entry, version }
        if (existing) {
          attachWork(existing, item, activeContext, expected, false)
          continue
        }

        let work = workItems.get(workKey)
        if (!work) {
          const { promise, resolve, reject } = Promise.withResolvers<CountResult>()
          work = {
            key: workKey,
            identity,
            version,
            text: entry.content,
            promise,
            resolve,
            reject,
          }
          workItems.set(workKey, work)
          activeCounts.set(workKey, promise)
        }
        attachWork(work.promise, item, activeContext, expected, true)
      }

      const pending = [...workItems.values()]
      const tokens = activeContext.host.tokens
      for (let offset = 0; offset < pending.length; offset += MAX_BATCH_SIZE) {
        if (!isCurrent(expected) || !tokens) {
          for (const work of pending.slice(offset)) work.reject(new Error('TOKEN_COUNT_STALE'))
          return
        }
        const batch = pending.slice(offset, offset + MAX_BATCH_SIZE)
        try {
          const rawResults = await Promise.all(batch.map(work => tokens.countText(work.text)))
          if (!isCurrent(expected)) {
            for (const work of batch) work.reject(new Error('TOKEN_COUNT_STALE'))
            return
          }
          batch.forEach((work, index) => {
            const result = countResult(rawResults[index])
            if (!result) {
              work.reject(new Error('TOKEN_COUNT_UNAVAILABLE'))
              return
            }
            if (latestVersions.get(work.identity)?.version === work.version) {
              cachedCounts.set(work.identity, { version: work.version, result })
            }
            work.resolve(result)
            activeCounts.delete(work.key)
          })
        } catch (error) {
          for (const work of batch) {
            work.reject(error)
            activeCounts.delete(work.key)
          }
        }
        if (offset + MAX_BATCH_SIZE < pending.length) await yieldBetweenBatches()
      }
    }
  }

  const scheduleReconcile = (): void => {
    if (reconcileQueued || !running || !enabled) return
    reconcileQueued = true
    const expected = generation
    const serial = reconcileSerial + 1
    reconcileSerial = serial
    queueMicrotask(() => {
      reconcileQueued = false
      void reconcile(expected, serial)
    })
  }

  const decorateRow = (element: HTMLElement): void | (() => void) => {
    const row = element
    const entryId = row.dataset.worldBookEntryRow
    const bookId = bookIdFromScopedRow(row)
    if (!entryId || !bookId) return
    decoratedRows.set(row, { row, bookId, entryId })
    const view = ownerDocumentOf(row)?.defaultView
    const Observer = view?.MutationObserver
    const observer = Observer
      ? new Observer(() => {
          const nextId = row.dataset.worldBookEntryRow
          const nextBook = bookIdFromScopedRow(row)
          if (nextId && nextBook) decoratedRows.set(row, { row, bookId: nextBook, entryId: nextId })
          scheduleReconcile()
        })
      : undefined
    observer?.observe(row, {
      attributes: true,
      attributeFilter: ['data-world-book-entry-row', 'data-world-book-entry-revision'],
      childList: true,
    })
    scheduleReconcile()
    return () => {
      observer?.disconnect()
      const badge = row.querySelector<HTMLElement>(BADGE_SELECTOR)
      const uuid = context ? readExtensionInstallationId(context.host) : undefined
      if (badge && ownedBadge(badge, uuid)) badge.remove()
      decoratedRows.delete(row)
    }
  }

  const deactivate = (): void => {
    generation += 1
    reconcileSerial += 1
    reconcileQueued = false
    decoratorHandle?.destroy()
    decoratorHandle = undefined
    for (const decorated of [...decoratedRows.values()]) {
      const badge = decorated.row.querySelector<HTMLElement>(BADGE_SELECTOR)
      const uuid = context ? readExtensionInstallationId(context.host) : undefined
      if (badge && ownedBadge(badge, uuid)) badge.remove()
    }
    decoratedRows.clear()
    activeCounts.clear()
    latestVersions.clear()
    if (stylesActive) {
      context?.styles.clear()
      stylesActive = false
    }
  }

  const activate = (): void => {
    const activeContext = context
    if (!activeContext || decoratorHandle || !running || !enabled) return
    generation += 1
    if (!stylesActive) {
      activeContext.styles.add(MODULE_STYLES, { scope: 'global' })
      stylesActive = true
    }
    const register = activeContext.host.registerDomDecorator
    if (typeof register !== 'function') return
    decoratorHandle = register({
      target: ROW_DECORATOR_TARGET,
      decorate: decorateRow,
    })
    scheduleReconcile()
  }

  return {
    id: MODULE_ID,
    async start(nextContext) {
      if (running) return
      if (!nextContext) throw new Error('LOREBOOK_TOKEN_COUNTS_CONTEXT_REQUIRED')
      context = nextContext
      settings = requireSuiteSettings(nextContext)
      const startGeneration = generation + 1
      generation = startGeneration
      const saved = await settings.get<boolean>(LOREBOOK_TOKEN_COUNTS_ENABLED_KEY)
      if (generation !== startGeneration || context !== nextContext) return
      enabled = saved !== false
      if (saved === undefined) await settings.set(LOREBOOK_TOKEN_COUNTS_ENABLED_KEY, true)
      if (generation !== startGeneration || context !== nextContext) return
      running = true
      stopSettingsWatch = settings.watch<boolean>(LOREBOOK_TOKEN_COUNTS_ENABLED_KEY, (value) => {
        const nextEnabled = value !== false
        if (nextEnabled === enabled) return
        enabled = nextEnabled
        if (enabled) activate()
        else deactivate()
      })
      stopCountUpdates = nextContext.bus?.on('tokens/count-updated', updateFromBus)
      if (enabled) activate()
    },
    stop() {
      if (!running && !context) return
      running = false
      stopSettingsWatch?.()
      stopSettingsWatch = undefined
      stopCountUpdates?.()
      stopCountUpdates = undefined
      deactivate()
      settings = undefined
      context = undefined
      cachedCounts.clear()
      latestVersions.clear()
    },
  }
}
