import { useStore } from '@/store'
import type { ActivatedWorldInfoEntry, ConnectionProfile } from '@/types/api'
import type { AppStore } from '@/types/store'
import { getUiScale } from '@/lib/uiScale'
import type { FrontendAuthorityResolver } from './frontend-authority-seam'

export type SelectorId = string

export interface SelectorInfo {
  id: SelectorId
  permission: string | null
  description: string
}

export interface StateSelector<T = unknown> extends SelectorInfo {
  read(state: AppStore): T
  same(a: T, b: T): boolean
}

export interface StateSelectorStore {
  getState(): AppStore
  subscribe(listener: (state: AppStore, previousState?: AppStore) => void): () => void
}

export interface StateSelectors {
  get<T = unknown>(id: SelectorId): T
  subscribe<T = unknown>(id: SelectorId, handler: (value: T) => void): () => void
  list(): SelectorInfo[]
  revokePermissions(permissions: readonly string[]): void
  dispose(): void
}

export interface CreateStateSelectorsOptions {
  assertActive(): void
  resolveAuthority: FrontendAuthorityResolver
  grantedPermissions?: () => readonly string[]
  onTeardown(handler: () => void): () => void
  store?: StateSelectorStore
  settingIds?: readonly string[]
}

interface SelectorChannel {
  selector: StateSelector
  listeners: Set<(value: unknown) => void>
  unsubscribe?: () => void
  lastValue?: unknown
  hasLastValue: boolean
}

const SELECTOR_UNKNOWN = 'SELECTOR_UNKNOWN'

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameValue(value, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && sameValue(aRecord[key], bRecord[key]))
}

function safeProfile(profile: ConnectionProfile): ConnectionProfile {
  const source = profile as ConnectionProfile & { api_key?: unknown }
  const { api_key: _apiKey, ...safe } = source
  return safe as ConnectionProfile
}

function readLayout() {
  const scale = getUiScale()
  if (typeof document === 'undefined') {
    return { chatRowWidth: 0, chatRowHeight: 0, chatColumnInnerMaxWidth: 0, uiScale: scale }
  }

  const body = document.querySelector('.body')
  const chatColumn = document.querySelector('.chatColumn')
  const chatColumnInner = document.querySelector('.chatColumnInner')
  const size = (element: Element | null) => {
    if (!element || typeof (element as HTMLElement).getBoundingClientRect !== 'function') {
      return { width: 0, height: 0 }
    }
    const rect = (element as HTMLElement).getBoundingClientRect()
    return {
      width: Number.isFinite(rect.width) ? rect.width / scale : 0,
      height: Number.isFinite(rect.height) ? rect.height / scale : 0,
    }
  }
  const chatSize = size(chatColumn)
  const bodySize = size(body)
  const maxWidth = chatColumnInner && typeof getComputedStyle === 'function'
    ? Number.parseFloat(getComputedStyle(chatColumnInner).maxWidth)
    : Number.NaN
  return {
    chatRowWidth: chatSize.width,
    chatRowHeight: bodySize.height,
    chatColumnInnerMaxWidth: Number.isFinite(maxWidth) ? maxWidth : 0,
    uiScale: scale,
  }
}

function readSelectedWorldInfoEntryId(): string | null {
  if (typeof document === 'undefined') return null
  const selectors = [
    '[data-entry-id][data-selected="true"]',
    '[data-entry-id][aria-selected="true"]',
    '[data-entry-id].selected',
  ]
  for (const selector of selectors) {
    const element = document.querySelector(selector)
    const id = element?.getAttribute('data-entry-id')
    if (id) return id
  }
  return null
}

type ActivatedWorldInfoProjection = Pick<ActivatedWorldInfoEntry,
  'id' | 'comment' | 'keys' | 'source' | 'score' | 'bookSource' | 'bookId' | 'bookName'
>

function readActivatedWorldInfo(entries: ActivatedWorldInfoEntry[]): ActivatedWorldInfoProjection[] {
  return entries.map((entry) => {
    const safe: ActivatedWorldInfoProjection = {
      id: entry.id,
      comment: entry.comment,
      keys: [...entry.keys],
      source: entry.source,
    }
    if (entry.score !== undefined) safe.score = entry.score
    if (entry.bookSource !== undefined) safe.bookSource = entry.bookSource
    if (entry.bookId !== undefined) safe.bookId = entry.bookId
    if (entry.bookName !== undefined) safe.bookName = entry.bookName
    return safe
  })
}

function namedSelectors(): Array<StateSelector> {
  return [
    {
      id: 'ui.activeModal',
      permission: null,
      description: 'The active modal name without modal props.',
      read: (state) => ({ activeModal: state.activeModal }),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'ui.drawer',
      permission: null,
      description: 'The built-in drawer open state and selected tab.',
      read: (state) => ({ open: state.drawerOpen, tabId: state.drawerTab }),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'ui.settings',
      permission: null,
      description: 'The built-in settings modal open state and view.',
      read: (state) => ({ open: state.settingsModalOpen, view: state.settingsActiveView }),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'ui.layout',
      permission: null,
      description: 'Current chat row geometry in layout pixels and UI scale.',
      read: () => readLayout(),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'chat.active',
      permission: null,
      description: 'The active chat, character, and avatar image identifiers.',
      read: (state) => ({
        chatId: state.activeChatId,
        characterId: state.activeCharacterId,
        avatarImageId: state.activeChatAvatarId,
      }),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'chat.messageCount',
      permission: null,
      description: 'Number of messages in the active chat store projection.',
      read: (state) => state.messages.length,
      same: Object.is,
    },
    {
      id: 'characters.favorites',
      permission: null,
      description: 'Favorite character identifiers.',
      read: (state) => state.favorites,
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'characters.browser',
      permission: null,
      description: 'Character browser filter, sort, and view state.',
      read: (state) => ({
        filterTab: state.filterTab,
        sortField: state.sortField,
        sortDirection: state.sortDirection,
        viewMode: state.viewMode,
      }),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'characters.editingId',
      permission: 'characters',
      description: 'The character currently being edited.',
      read: (state) => state.editingCharacterId,
      same: Object.is,
    },
    {
      id: 'connections.active',
      permission: null,
      description: 'Active connection profile identifier and model projection.',
      read: (state) => {
        const profile = state.profiles.find((candidate) => candidate.id === state.activeProfileId)
        return {
          activeProfileId: state.activeProfileId,
          provider: profile?.provider ?? null,
          model: profile?.model ?? null,
        }
      },
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'connections.profiles',
      permission: null,
      description: 'Connection profiles without credential fields.',
      read: (state) => state.profiles.map(safeProfile),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'worldInfo.activated',
      permission: null,
      description: 'World-info activation metadata without entry content.',
      read: (state) => readActivatedWorldInfo(state.activatedWorldInfo),
      same: (a, b) => sameValue(a, b),
    },
    {
      id: 'worldInfo.selectedEntryId',
      permission: null,
      description: 'Selected world-book entry identifier from the editor surface.',
      read: () => readSelectedWorldInfoEntryId(),
      same: Object.is,
    },
    {
      id: 'loom.activePresetId',
      permission: null,
      description: 'Currently active Loom preset identifier.',
      read: (state) => state.activeLoomPresetId,
      same: Object.is,
    },
    {
      id: 'persona.activeId',
      permission: null,
      description: 'Currently active persona identifier.',
      read: (state) => state.activePersonaId,
      same: Object.is,
    },
  ]
}

function settingSelector(id: string): StateSelector {
  const key = id.slice('setting:'.length)
  return {
    id,
    permission: null,
    description: `Read-only core setting: ${key}.`,
    read: (state) => Reflect.get(state, key) ?? null,
    same: (a, b) => sameValue(a, b),
  }
}

function unknownSelector(id: string): never {
  throw new Error(`${SELECTOR_UNKNOWN}:${id}`)
}

/**
 * Creates H2's selector registry. Authority classification is supplied by a
 * separate seam; production can therefore fail closed until the authority-map
 * lane is integrated without changing selector behavior or tests.
 */
export function createStateSelectors(options: CreateStateSelectorsOptions): StateSelectors {
  const store = options.store ?? useStore
  const definitions = new Map<SelectorId, StateSelector>()
  for (const selector of namedSelectors()) definitions.set(selector.id, selector)
  for (const settingId of options.settingIds ?? []) {
    const id = settingId.startsWith('setting:') ? settingId : `setting:${settingId}`
    definitions.set(id, settingSelector(id))
  }

  const channels = new Map<SelectorId, SelectorChannel>()
  let disposed = false

  const assertUsable = () => {
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: state selector registry is disposed')
    options.assertActive()
  }

  const authorityFor = (id: string): string | null => {
    const result = options.resolveAuthority(id)
    return result.permission
  }

  const ensurePermission = (selector: StateSelector) => {
    const permission = authorityFor(selector.id)
    if (permission === null) return
    if (!(options.grantedPermissions?.() ?? []).includes(permission)) {
      throw new Error(`PERMISSION_DENIED:${permission} — ${selector.id} requires the ${permission} permission`)
    }
  }

  const getSelector = (id: string): StateSelector => definitions.get(id) ?? unknownSelector(id)

  const stopChannel = (channel: SelectorChannel) => {
    channel.unsubscribe?.()
    channel.unsubscribe = undefined
    channel.listeners.clear()
    channels.delete(channel.selector.id)
  }

  const startChannel = (selector: StateSelector): SelectorChannel => {
    const channel: SelectorChannel = {
      selector,
      listeners: new Set(),
      hasLastValue: false,
    }
    channel.lastValue = selector.read(store.getState())
    channel.hasLastValue = true

    const publish = (state = store.getState()) => {
      if (disposed || channel.listeners.size === 0) return
      const next = selector.read(state)
      if (channel.hasLastValue && selector.same(channel.lastValue, next)) return
      channel.lastValue = next
      channel.hasLastValue = true
      for (const listener of [...channel.listeners]) {
        const value = structuredClone(next)
        try {
          listener(value)
        } catch {
          // Extension callback failures are isolated from the host store.
        }
      }
    }

    const stopStore = store.subscribe(publish)
    const layoutDisposers: Array<() => void> = []
    if (selector.id === 'ui.layout' && typeof window !== 'undefined') {
      const onLayoutSignal = () => publish()
      window.addEventListener('resize', onLayoutSignal)
      layoutDisposers.push(() => window.removeEventListener('resize', onLayoutSignal))
      window.visualViewport?.addEventListener('resize', onLayoutSignal)
      window.visualViewport?.addEventListener('scroll', onLayoutSignal)
      layoutDisposers.push(() => {
        window.visualViewport?.removeEventListener('resize', onLayoutSignal)
        window.visualViewport?.removeEventListener('scroll', onLayoutSignal)
      })
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        const observer = new MutationObserver(onLayoutSignal)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
        layoutDisposers.push(() => observer.disconnect())
      }
    }

    channel.unsubscribe = () => {
      stopStore()
      for (const disposeLayout of layoutDisposers) disposeLayout()
    }
    channels.set(selector.id, channel)
    return channel
  }

  const registry: StateSelectors = {
    get<T = unknown>(id) {
      assertUsable()
      const selector = getSelector(id)
      ensurePermission(selector)
      return structuredClone(selector.read(store.getState())) as T
    },

    subscribe<T = unknown>(id, handler) {
      assertUsable()
      const selector = getSelector(id)
      ensurePermission(selector)
      const channel = channels.get(id) ?? startChannel(selector)
      const listener = handler as (value: unknown) => void
      channel.listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        channel.listeners.delete(listener)
        if (channel.listeners.size === 0) stopChannel(channel)
      }
    },

    list() {
      assertUsable()
      return [...definitions.values()].map((selector) => ({
        id: selector.id,
        permission: authorityFor(selector.id),
        description: selector.description,
      }))
    },

    revokePermissions(permissions) {
      if (disposed) return
      const revoked = new Set(permissions)
      for (const channel of [...channels.values()]) {
        const permission = authorityFor(channel.selector.id)
        if (permission !== null && revoked.has(permission)) stopChannel(channel)
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const channel of [...channels.values()]) stopChannel(channel)
    },
  }

  options.onTeardown(registry.dispose)
  return registry
}
