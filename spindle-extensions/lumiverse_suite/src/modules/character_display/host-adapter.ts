import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import type { SuiteHostContext } from '../../suite'
import type {
  CharacterDisplayChatSummary,
  CharacterDisplaySelection,
} from './types'

type JsonRecord = Record<string, unknown>
type Dispose = () => void
type UnknownFunction = (...args: unknown[]) => unknown

type CharacterDisplaySurfaceProps = Record<string, unknown>
type CharacterDisplaySurfaceEventHandler = (payload: unknown) => void

interface StructuralStatePort {
  get?: UnknownFunction
  subscribe?: UnknownFunction
  on?: UnknownFunction
}

interface StructuralUI {
  mount?(point: string): unknown
  registerSettingsTab?: UnknownFunction
  navigate?: UnknownFunction
  openCharacter?: UnknownFunction
  openChat?: UnknownFunction
  editCharacter?: UnknownFunction
  toggleFavorite?: UnknownFunction
  toggleBatch?: UnknownFunction
  events?: StructuralStatePort
  navigation?: StructuralStatePort
}

interface StructuralComponents {
  mountHostSurface?: UnknownFunction
  mountRangeSlider?: UnknownFunction
  mountSelect?: UnknownFunction
  mountSwitch?: UnknownFunction
  mountMultiSelect?: UnknownFunction
  [key: string]: unknown
}

interface StructuralSurfaces {
  invoke?: UnknownFunction
  subscribe?: UnknownFunction
  registerDeepLinkTarget?: UnknownFunction
}

interface StructuralHost {
  extensionInstallationId?: unknown
  surfaces?: StructuralSurfaces
  navigation?: StructuralStatePort
}

interface CharacterDisplayRuntimeContext {
  host?: StructuralHost
  ui?: StructuralUI
  components?: StructuralComponents
  state?: StructuralStatePort
  characters?: { get?: UnknownFunction }
  character?: { get?: UnknownFunction }
  chats?: { listForCharacter?: UnknownFunction; getActive?: UnknownFunction }
  worldBooks?: { list?: UnknownFunction; listAll?: UnknownFunction }
  events?: StructuralStatePort
  navigation?: StructuralStatePort
  getActiveChat?: UnknownFunction
  getActiveCharacter?: UnknownFunction
  getCharacter?: UnknownFunction
  document?: unknown
  fetch?: UnknownFunction
}

/** A normalized host-surface handle with safe, idempotent teardown. */
export interface CharacterDisplaySurfaceHandle {
  readonly root?: HTMLElement
  update(props: CharacterDisplaySurfaceProps): void
  destroy(): void
  on(event: string, handler: CharacterDisplaySurfaceEventHandler): Dispose
}

export interface CharacterDisplayComponents {
  readonly mountRangeSlider?: UnknownFunction
  readonly mountSelect?: UnknownFunction
  readonly mountSwitch?: UnknownFunction
  readonly mountMultiSelect?: UnknownFunction
  readonly mountHostSurface?: UnknownFunction
  readonly [key: string]: unknown
}

export interface CharacterDisplayNavigationReference {
  readonly kind: 'route' | 'drawer_tab' | 'settings_tab' | 'command' | 'modal'
  readonly id: string
}

export interface CharacterDisplayHostAdapter {
  readonly components?: CharacterDisplayComponents
  readActiveCharacter(): CharacterDisplaySelection
  getActiveCharacter(): CharacterDisplaySelection
  subscribeActiveCharacter(listener: (selection: CharacterDisplaySelection) => void): Dispose
  getCharacter(characterId: string): Promise<unknown | null>
  applyBrowserDefaults(
    surface: 'homepage' | 'characters-tab',
    settings: unknown,
    signal?: AbortSignal,
  ): Promise<void>
  listThisChatCharacters(signal?: AbortSignal): Promise<readonly unknown[]>
  listAttachedWorldBooks(
    character: unknown,
    signal?: AbortSignal,
  ): Promise<readonly { readonly id: string; readonly name: string }[]>
  listChatsForCharacter(
    characterId: string,
    signal?: AbortSignal,
  ): Promise<readonly CharacterDisplayChatSummary[]>
  registerSettings(render: (root: HTMLElement) => unknown): Dispose
  mountHostSurface(
    target: unknown,
    surfaceId: string,
    props?: CharacterDisplaySurfaceProps,
  ): CharacterDisplaySurfaceHandle | undefined
  markOwnedRoot(root: unknown): HTMLElement | undefined
  navigate(
    reference: CharacterDisplayNavigationReference,
    params?: CharacterDisplaySurfaceProps,
  ): void | Promise<void>
  openCharacter(characterId: string): void | Promise<void>
  openChat(chatId: string): void | Promise<void>
  openWorldBook(bookId: string): void | Promise<void>
  editCharacter(characterId: string): void | Promise<void>
  toggleFavorite(characterId: string): void | Promise<void>
  toggleBatch(characterId: string, selected: boolean): void | Promise<void>
  subscribeNavigation(listener: (payload: unknown) => void): Dispose
  onNavigation(listener: (payload: unknown) => void): Dispose
}

const MAX_CHAT_FALLBACK_RESULTS = 100
const MAX_CHARACTER_RESULTS = 100
const MAX_WORLD_BOOK_RESULTS = 200
const MAX_PREVIEW_LENGTH = 280
const EXTENSION_IDENTIFIER = 'lumiverse_suite'
const MODULE_ID = 'character_display'
const NOOP: Dispose = () => undefined

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFunction(value: unknown): UnknownFunction | undefined {
  return typeof value === 'function' ? value as UnknownFunction : undefined
}

function method(source: unknown, name: string): UnknownFunction | undefined {
  if (!isRecord(source)) return undefined
  return asFunction(source[name])
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown, maxLength = 4096): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  if (result.length === 0 || result.length > maxLength) return undefined
  return result
}

function id(value: unknown): string | undefined {
  return text(value, 256)
}

function valueAt(source: JsonRecord | undefined, keys: readonly string[]): unknown {
  if (!source) return undefined
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key]
  }
  return undefined
}

function textAt(source: JsonRecord | undefined, keys: readonly string[], maxLength = 4096): string | undefined {
  return text(valueAt(source, keys), maxLength)
}

function elementLike(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as JsonRecord
  return candidate.nodeType === 1
    || typeof candidate.append === 'function'
    || typeof candidate.appendChild === 'function'
    || typeof candidate.setAttribute === 'function'
}

function elementFrom(value: unknown, depth = 0): HTMLElement | undefined {
  if (depth > 3 || value === null || value === undefined) return undefined
  if (elementLike(value)) return value
  if (!isRecord(value)) return undefined
  return elementFrom(value.root ?? value.element ?? value.target, depth + 1)
}

function attribute(element: HTMLElement, name: string): string | undefined {
  try {
    const result = element.getAttribute?.(name)
    return typeof result === 'string' ? result : undefined
  } catch {
    return undefined
  }
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  try {
    element.setAttribute?.(name, value)
  } catch {
    // A partial test double may expose no attribute methods.
  }
}

function isConnected(element: HTMLElement): boolean {
  try {
    return element.isConnected === true
  } catch {
    return false
  }
}

function once(action: Dispose): Dispose {
  let active = true
  return () => {
    if (!active) return
    active = false
    try {
      action()
    } catch {
      // Host teardown must remain idempotent even when a root is already gone.
    }
  }
}

function toDispose(value: unknown): Dispose {
  if (typeof value === 'function') return once(() => { (value as Dispose)() })
  if (!isRecord(value)) return NOOP
  const destroy = method(value, 'destroy')
  if (destroy) return once(() => { destroy.call(value) })
  const dispose = method(value, 'dispose')
  if (dispose) return once(() => { dispose.call(value) })
  const unsubscribe = method(value, 'unsubscribe')
  if (unsubscribe) return once(() => { unsubscribe.call(value) })
  const unmount = method(value, 'unmount')
  if (unmount) return once(() => { unmount.call(value) })
  return NOOP
}

function normalizeActive(value: unknown): CharacterDisplaySelection {
  const root = isRecord(value) && isRecord(value.active) ? value.active : value
  const record = isRecord(root) ? root : undefined
  const character = isRecord(record?.character) ? record.character : undefined
  const characterId = id(value) ?? id(valueAt(record, ['characterId', 'character_id', 'activeCharacterId', 'active_character_id']))
    ?? id(valueAt(character, ['id', 'characterId', 'character_id']))
  const scope = valueAt(record, ['scope', 'libraryScope', 'library_scope'])
  const surface = valueAt(record, ['surface', 'displaySurface', 'display_surface'])
  const characterName = textAt(record, ['characterName', 'character_name', 'name'], 4096)
    ?? textAt(character, ['name'], 4096)

  return {
    characterId: characterId ?? null,
    ...(scope === 'mine' || scope === 'shared' ? { scope } : {}),
    ...(surface === 'homepage' || surface === 'characters-tab' ? { surface } : {}),
    ...(characterName ? { characterName } : {}),
  }
}

function unwrapCharacter(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (isRecord(value.character)) return value.character
  if (isRecord(value.data)) {
    if (isRecord(value.data.character)) return value.data.character
    return value.data
  }
  return value
}

function chatArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const key of ['data', 'chats', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key]
  }
  if (isRecord(value.chat)) return [value.chat]
  return []
}

function normalizeChat(value: unknown): CharacterDisplayChatSummary | null {
  const source = isRecord(value)
    ? (isRecord(value.chat) ? value.chat : value)
    : undefined
  if (!source) return null
  const chatId = id(valueAt(source, ['id', 'chatId', 'chat_id']))
  if (!chatId) return null
  const name = textAt(source, ['name', 'chatName', 'chat_name'], 4096)
  if (!name) return null
  const messageCountValue = finite(valueAt(source, ['messageCount', 'message_count']))
  const updatedAtValue = finite(valueAt(source, ['updatedAt', 'updated_at']))
  const createdAtValue = finite(valueAt(source, ['createdAt', 'created_at']))
  const preview = textAt(source, ['lastMessagePreview', 'last_message_preview', 'preview'], 4096)?.slice(0, MAX_PREVIEW_LENGTH) ?? ''
  const isGroupValue = valueAt(source, ['isGroup', 'is_group', 'group'])
  return {
    id: chatId,
    name,
    messageCount: messageCountValue === undefined ? 0 : Math.max(0, Math.round(messageCountValue)),
    lastMessagePreview: preview.slice(0, MAX_PREVIEW_LENGTH),
    updatedAt: updatedAtValue === undefined ? 0 : Math.max(0, updatedAtValue),
    ...(createdAtValue === undefined ? {} : { createdAt: Math.max(0, createdAtValue) }),
    ...(typeof isGroupValue === 'boolean' ? { isGroup: isGroupValue } : {}),
  }
}

function normalizeChats(value: unknown, limit?: number): readonly CharacterDisplayChatSummary[] {
  const normalized: CharacterDisplayChatSummary[] = []
  const max = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit)
  for (const item of chatArray(value)) {
    const chat = normalizeChat(item)
    if (!chat) continue
    normalized.push(chat)
    if (normalized.length >= max) break
  }
  return normalized
}

function responseOkay(response: JsonRecord): boolean {
  if (response.ok === false) return false
  const status = finite(response.status)
  return status === undefined || status >= 200 && status < 300
}

async function responseJson(response: unknown): Promise<unknown> {
  if (isRecord(response)) {
    const json = method(response, 'json')
    if (json) return json.call(response)
    const textReader = method(response, 'text')
    if (textReader) {
      const body = await textReader.call(response)
      if (typeof body !== 'string' || body.trim().length === 0) return undefined
      return JSON.parse(body)
    }
  }
  return response
}

type CharacterDisplayWorldBookSummary = { readonly id: string; readonly name: string }

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

function cloneJsonSafe(value: unknown): unknown | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    return JSON.parse(serialized)
  } catch {
    return undefined
  }
}

function activeChatRecord(value: unknown): JsonRecord | undefined {
  let candidate = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(candidate)) return undefined
    const nested = [candidate.activeChat, candidate.active_chat, candidate.active, candidate.chat, candidate.data]
      .find(isRecord)
    if (!nested) return candidate
    candidate = nested
  }
  return undefined
}
function activeChatId(value: unknown): string | undefined {
  const chat = activeChatRecord(value)
  return id(valueAt(chat, ['id', 'chatId', 'chat_id', 'activeChatId', 'active_chat_id']))
}

function activeChatCharacterIds(value: unknown): readonly string[] {
  const chat = activeChatRecord(value)
  if (!chat) return []
  const ids: string[] = []
  const seen = new Set<string>()
  const append = (candidate: unknown): void => {
    const normalized = id(candidate)
    if (!normalized || seen.has(normalized) || ids.length >= MAX_CHARACTER_RESULTS) return
    seen.add(normalized)
    ids.push(normalized)
  }
  append(valueAt(chat, ['character_id', 'characterId']))
  const metadata = valueAt(chat, ['metadata'])
  if (isRecord(metadata)) {
    const metadataIds = valueAt(metadata, ['character_ids', 'characterIds'])
    if (Array.isArray(metadataIds)) {
      for (const candidate of metadataIds) append(candidate)
    }
  }
  return ids
}

function worldBookArray(value: unknown): readonly unknown[] {
  let candidate = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(candidate)) return candidate
    if (!isRecord(candidate)) return []
    const array = ['data', 'world_books', 'worldBooks', 'books', 'items', 'results']
      .map(key => isRecord(candidate) ? candidate[key] : undefined)
      .find(Array.isArray)
    if (array) return array
    const nested = [candidate.data, candidate.world_books, candidate.worldBooks, candidate.books]
      .find(isRecord)
    if (!nested) return []
    candidate = nested
  }
  return []
}

function normalizeWorldBooks(value: unknown): readonly CharacterDisplayWorldBookSummary[] {
  const rows: CharacterDisplayWorldBookSummary[] = []
  const seen = new Set<string>()
  for (const item of worldBookArray(value)) {
    if (!isRecord(item)) continue
    const bookId = id(valueAt(item, ['id', 'worldBookId', 'world_book_id']))
    const name = textAt(item, ['name', 'title'], 4096)
    if (!bookId || !name || seen.has(bookId)) continue
    seen.add(bookId)
    rows.push({ id: bookId, name })
    if (rows.length >= MAX_WORLD_BOOK_RESULTS) break
  }
  return rows
}

function attachedWorldBookIds(character: unknown): readonly string[] {
  const source = unwrapCharacter(character)
  if (!isRecord(source) || !isRecord(source.extensions)) return []
  const rawIds = valueAt(source.extensions, ['world_book_ids', 'worldBookIds'])
  if (!Array.isArray(rawIds)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const rawId of rawIds) {
    const normalized = id(rawId)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    ids.push(normalized)
    if (ids.length >= MAX_WORLD_BOOK_RESULTS) break
  }
  return ids
}

function installedExtensionUuid(ctx: CharacterDisplayRuntimeContext): string | undefined {
  const value = id(ctx.host?.extensionInstallationId)
  return value && value.length <= 256 ? value : undefined
}

function markRoot(root: unknown, extensionUuid: string | undefined): HTMLElement | undefined {
  const element = elementFrom(root)
  if (!element || !extensionUuid) return element
  const previousRoot = attribute(element, 'data-spindle-extension-root')
  const previousExt = attribute(element, 'data-spindle-ext')
  if ((previousRoot && previousRoot !== extensionUuid) || (previousExt && previousExt !== extensionUuid)) {
    return element
  }
  setAttribute(element, 'data-spindle-extension-root', extensionUuid)
  setAttribute(element, 'data-spindle-ext', extensionUuid)
  setAttribute(element, 'data-spindle-ext-id', EXTENSION_IDENTIFIER)
  setAttribute(element, 'data-lumiverse-module', MODULE_ID)
  return element
}

function shouldClaimDetachedRoot(element: HTMLElement): boolean {
  if (isConnected(element)) return false
  const owner = attribute(element, 'data-spindle-extension-root') ?? attribute(element, 'data-spindle-ext')
  return !owner
}

function normalizedSurfaceHandle(value: unknown): CharacterDisplaySurfaceHandle | undefined {
  let raw = value
  for (let depth = 0; depth < 3 && isRecord(raw); depth += 1) {
    const nested = raw.handle ?? raw.surface
    if (nested === undefined || nested === raw) break
    raw = nested
  }
  if (!isRecord(raw)) return undefined
  const update = method(raw, 'update')
  const destroy = method(raw, 'destroy') ?? method(raw, 'dispose') ?? method(raw, 'unmount')
  const on = method(raw, 'on')
  if (!update && !destroy && !on) return undefined

  let active = true
  return {
    root: elementFrom(raw),
    update(props) {
      if (!active || !update) return
      update.call(raw, props)
    },
    destroy() {
      if (!active) return
      active = false
      if (destroy) destroy.call(raw)
    },
    on(event, handler) {
      if (!active || !on || typeof event !== 'string' || typeof handler !== 'function') return NOOP
      let subscription: unknown
      try {
        subscription = on.call(raw, event, handler)
      } catch {
        return NOOP
      }
      return toDispose(subscription)
    },
  }
}

function readActiveValue(ctx: CharacterDisplayRuntimeContext): unknown {
  const directCharacter = method(ctx, 'getActiveCharacter')
  if (directCharacter) {
    try {
      const value = directCharacter.call(ctx)
      if (value !== undefined) return value
    } catch {
      // Fall through to the public active-chat read.
    }
  }
  const activeChat = method(ctx, 'getActiveChat')
  if (activeChat) {
    try {
      const value = activeChat.call(ctx)
      if (value !== undefined) return value
    } catch {
      // Fall through to structural state selectors.
    }
  }
  const selectors: Array<[unknown, string]> = [
    [ctx.state, 'chat.active'],
    [ctx.ui?.events, 'chat.active'],
    [ctx.ui?.events, 'activeCharacter'],
  ]
  for (const [source, selector] of selectors) {
    const get = method(source, 'get')
    if (!get) continue
    try {
      const value = get.call(source, selector)
      if (value !== undefined) return value
    } catch {
      // Optional host surface.
    }
  }
  return valueAt(isRecord(ctx) ? ctx : undefined, ['activeCharacterId', 'active_character_id'])
}

function subscribePort(
  source: unknown,
  methodName: string,
  eventName: string,
  listener: (value: unknown) => void,
): Dispose | undefined {
  const subscribe = method(source, methodName)
  if (!subscribe) return undefined
  try {
    const value = subscribe.call(source, eventName, listener)
    return toDispose(value)
  } catch {
    return undefined
  }
}

function navigationRegistration(
  source: unknown,
  listener: (value: unknown) => void,
): Dispose | undefined {
  if (!isRecord(source)) return undefined
  for (const methodName of ['subscribe', 'on', 'watch']) {
    const register = method(source, methodName)
    if (!register) continue
    try {
      return toDispose(register.call(source, listener))
    } catch {
      // Try the next optional navigation shape.
    }
  }
  return undefined
}

function navigationFallback(
  ctx: CharacterDisplayRuntimeContext,
  reference: CharacterDisplayNavigationReference,
  params: CharacterDisplaySurfaceProps,
): void | Promise<void> {
  const ui = ctx.ui
  const idValue = params.id
  if (reference.id === '/characters/:id' && idValue) {
    const openCharacter = method(ui, 'openCharacter')
    if (openCharacter) return openCharacter.call(ui, idValue) as void | Promise<void>
  }
  if (reference.id === '/chat/:chatId' && idValue) {
    const openChat = method(ui, 'openChat')
    if (openChat) return openChat.call(ui, idValue) as void | Promise<void>
  }
  const uiNavigate = method(ui, 'navigate')
  if (uiNavigate) return uiNavigate.call(ui, reference.id, params) as void | Promise<void>
  const contextNavigate = method(ctx.navigation, 'navigate')
  if (contextNavigate) return contextNavigate.call(ctx.navigation, reference.id, params) as void | Promise<void>
  const directNavigate = method(ctx, 'navigate')
  if (directNavigate) return directNavigate.call(ctx, reference.id, params) as void | Promise<void>
  return undefined
}

function toCharacterDisplayRuntime(ctx: SuiteHostContext): CharacterDisplayRuntimeContext {
  const runtime: unknown = ctx
  return runtime as CharacterDisplayRuntimeContext
}

export function createCharacterDisplayHostAdapter(ctx: SuiteHostContext): CharacterDisplayHostAdapter {
  const runtime = toCharacterDisplayRuntime(ctx)
  const extensionUuid = installedExtensionUuid(runtime)
  let worldBookCache: readonly CharacterDisplayWorldBookSummary[] | undefined
  let worldBookSweepPromise: Promise<readonly CharacterDisplayWorldBookSummary[]> | undefined

  const readActiveCharacter = (): CharacterDisplaySelection => normalizeActive(readActiveValue(runtime))

  const subscribeActiveCharacter = (listener: (selection: CharacterDisplaySelection) => void): Dispose => {
    if (typeof listener !== 'function') return NOOP
    let active = true
    const notify = (value: unknown) => {
      if (!active) return
      try { listener(normalizeActive(value)) } catch { /* isolate extension observers */ }
    }
    const attempts: Array<() => Dispose | undefined> = [
      () => subscribePort(runtime.state, 'subscribe', 'chat.active', notify),
      () => subscribePort(runtime.ui?.events, 'subscribe', 'chat.active', notify),
      () => subscribePort(runtime.ui?.events, 'on', 'chat.active', notify),
      () => subscribePort(runtime.events, 'on', 'CHAT_SWITCHED', notify),
      () => subscribePort(runtime.events, 'on', 'CHAT_CHANGED', notify),
    ]
    let selected: Dispose | undefined
    for (const attempt of attempts) {
      selected = attempt()
      if (selected) break
    }
    if (!selected) {
      active = false
      return NOOP
    }
    return once(() => {
      active = false
      selected?.()
    })
  }

  const getCharacter = async (characterId: string): Promise<unknown | null> => {
    const normalizedId = id(characterId)
    if (!normalizedId) return null
    const characterGetter = method(runtime.characters, 'get')
    const legacyGetter = method(runtime.character, 'get')
    const directGetter = method(runtime, 'getCharacter')
    const getter = characterGetter ?? legacyGetter ?? directGetter
    const owner = characterGetter ? runtime.characters : legacyGetter ? runtime.character : runtime
    if (!getter) return null
    try {
      const value = await getter.call(owner, normalizedId)
      const character = unwrapCharacter(value)
      const cloned = cloneJsonSafe(character)
      return isRecord(cloned) ? cloned : null
    } catch {
      return null
    }
  }

  const applyBrowserDefaults = async (
    _surface: 'homepage' | 'characters-tab',
    settings: unknown,
    signal?: AbortSignal,
  ): Promise<void> => {
    const cloned = cloneJsonSafe(settings)
    if (!isRecord(cloned)) return
    const filterTab = valueAt(cloned, ['filterTab', 'defaultFilter'])
    const sortField = valueAt(cloned, ['sortField', 'defaultSort'])
    const sortDirection = valueAt(cloned, ['sortDirection']) ?? 'desc'
    const viewMode = valueAt(cloned, ['viewMode'])
    if ([filterTab, sortField, sortDirection, viewMode].some(value => value === undefined)) return
    throwIfAborted(signal)
    const runtimeFetcher = method(runtime, 'fetch')
    const globalFetcher = asFunction((globalThis as { fetch?: unknown }).fetch)
    const fetcher = runtimeFetcher ?? globalFetcher
    if (!fetcher) return
    const owner = runtimeFetcher ? runtime : globalThis
    const response = await fetcher.call(owner, '/api/v1/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filterTab, sortField, sortDirection, viewMode }),
      ...(signal ? { signal } : {}),
    })
    if (!isRecord(response) || !responseOkay(response)) {
      throw new Error('Failed to apply character display defaults')
    }
    throwIfAborted(signal)
  }

  const listThisChatCharacters = async (signal?: AbortSignal): Promise<readonly unknown[]> => {
    if (signal?.aborted) return []
    const directGetter = method(runtime, 'getActiveChat')
    const chatGetter = method(runtime.chats, 'getActive')
    const getter = directGetter ?? chatGetter
    let activeSelector: unknown
    if (getter) {
      const owner = directGetter ? runtime : runtime.chats
      try {
        activeSelector = await getter.call(owner)
      } catch {
        return []
      }
    } else {
      activeSelector = readActiveValue(runtime)
    }
    throwIfAborted(signal)
    const chatId = activeChatId(activeSelector)
    if (!chatId) return []
    const runtimeFetcher = method(runtime, 'fetch')
    const globalFetcher = asFunction((globalThis as { fetch?: unknown }).fetch)
    const fetcher = runtimeFetcher ?? globalFetcher
    if (!fetcher) return []
    const owner = runtimeFetcher ? runtime : globalThis
    let activeChat: unknown
    try {
      const response = await fetcher.call(owner, `/api/v1/chats/${encodeURIComponent(chatId)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(response) || !responseOkay(response)) return []
      activeChat = await responseJson(response)
    } catch (error) {
      if (signal?.aborted || isRecord(error) && error.name === 'AbortError') throw error
      return []
    }
    throwIfAborted(signal)
    const participantIds = activeChatCharacterIds(activeChat)
    if (participantIds.length === 0) return []
    const characters: unknown[] = []
    const seen = new Set<string>()
    for (const participantId of participantIds) {
      throwIfAborted(signal)
      const character = await getCharacter(participantId)
      throwIfAborted(signal)
      if (!isRecord(character)) continue
      const cloned = cloneJsonSafe(character)
      if (!isRecord(cloned)) continue
      const characterId = id(valueAt(cloned, ['id', 'characterId', 'character_id']))
      if (!characterId || seen.has(characterId)) continue
      seen.add(characterId)
      characters.push(cloned)
      if (characters.length >= MAX_CHARACTER_RESULTS) break
    }
    return characters
  }

  const readWorldBookSweep = async (
    signal?: AbortSignal,
  ): Promise<readonly CharacterDisplayWorldBookSummary[]> => {
    if (worldBookCache !== undefined) {
      throwIfAborted(signal)
      return worldBookCache.map(book => ({ ...book }))
    }
    if (worldBookSweepPromise) {
      const rows = await worldBookSweepPromise
      throwIfAborted(signal)
      return rows.map(book => ({ ...book }))
    }
    const hostListAll = method(runtime.worldBooks, 'listAll')
    const hostList = hostListAll ?? method(runtime.worldBooks, 'list')
    const sweep = (async (): Promise<readonly CharacterDisplayWorldBookSummary[]> => {
      throwIfAborted(signal)
      let payload: unknown
      if (hostList) {
        try {
          payload = hostListAll
            ? await hostList.call(runtime.worldBooks)
            : await hostList.call(runtime.worldBooks, {
              limit: MAX_WORLD_BOOK_RESULTS,
              offset: 0,
              ...(signal ? { signal } : {}),
            })
        } catch (error) {
          if (signal?.aborted) throw error
          return []
        }
      } else {
        const runtimeFetcher = method(runtime, 'fetch')
        const globalFetcher = asFunction((globalThis as { fetch?: unknown }).fetch)
        const fetcher = runtimeFetcher ?? globalFetcher
        if (!fetcher) return []
        const owner = runtimeFetcher ? runtime : globalThis
        try {
          const response = await fetcher.call(owner, `/api/v1/world-books?limit=${MAX_WORLD_BOOK_RESULTS}&offset=0`, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
            ...(signal ? { signal } : {}),
          })
          if (!isRecord(response) || !responseOkay(response)) return []
          payload = await responseJson(response)
        } catch (error) {
          if (signal?.aborted || isRecord(error) && error.name === 'AbortError') throw error
          return []
        }
      }
      throwIfAborted(signal)
      const rows = normalizeWorldBooks(payload)
      worldBookCache = rows
      return rows
    })()
    worldBookSweepPromise = sweep
    try {
      const rows = await sweep
      throwIfAborted(signal)
      return rows.map(book => ({ ...book }))
    } finally {
      if (worldBookSweepPromise === sweep) worldBookSweepPromise = undefined
    }
  }

  const listAttachedWorldBooks = async (
    character: unknown,
    signal?: AbortSignal,
  ): Promise<readonly CharacterDisplayWorldBookSummary[]> => {
    if (signal?.aborted) return []
    const attachedIds = attachedWorldBookIds(character)
    if (attachedIds.length === 0) return []
    const rows = await readWorldBookSweep(signal)
    const attached = new Set(attachedIds)
    return rows
      .filter(book => attached.has(book.id))
      .map(book => ({ id: book.id, name: book.name }))
  }

  const listChatsForCharacter = async (
    characterId: string,
    signal?: AbortSignal,
  ): Promise<readonly CharacterDisplayChatSummary[]> => {
    const normalizedId = id(characterId)
    if (!normalizedId || signal?.aborted) return []
    const h10 = method(runtime.chats, 'listForCharacter')
    if (h10) {
      // H10 is authoritative. A rejection is deliberately not converted into
      // a REST fallback because doing so would hide host lifecycle failures.
      const result = await h10.call(runtime.chats, normalizedId, signal)
      return normalizeChats(result, MAX_CHAT_FALLBACK_RESULTS)
    }

    const runtimeFetcher = method(runtime, 'fetch')
    const globalFetcher = asFunction((globalThis as { fetch?: unknown }).fetch)
    const fetcher = runtimeFetcher ?? globalFetcher
    if (!fetcher || signal?.aborted) return []
    const owner = runtimeFetcher ? runtime : globalThis
    try {
      const response = await fetcher.call(owner, `/api/v1/chats/character-chats/${encodeURIComponent(normalizedId)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(response) || !responseOkay(response)) return []
      const payload = await responseJson(response)
      return normalizeChats(payload, MAX_CHAT_FALLBACK_RESULTS)
    } catch (error) {
      if (signal?.aborted || isRecord(error) && error.name === 'AbortError') throw error
      return []
    }
  }

  const registerSettings = (render: (root: HTMLElement) => unknown): Dispose => {
    // Productivity owns one suite-level settings registration. Keep this
    // legacy adapter entry inert so old module callers cannot create a second
    // tab or settings body.
    void render
    return NOOP
  }

  const mountHostSurface = (
    target: unknown,
    surfaceId: string,
    props: CharacterDisplaySurfaceProps = {},
  ): CharacterDisplaySurfaceHandle | undefined => {
    const normalizedSurfaceId = text(surfaceId, 128)
    const mount = method(runtime.components, 'mountHostSurface')
    if (!normalizedSurfaceId || !mount) return undefined
    const element = elementFrom(target)
    if (element && shouldClaimDetachedRoot(element)) markRoot(element, extensionUuid)
    try {
      const value = mount.call(runtime.components, target, normalizedSurfaceId, isRecord(props) ? props : {})
      return normalizedSurfaceHandle(value)
    } catch {
      return undefined
    }
  }

  const navigate = (
    reference: CharacterDisplayNavigationReference,
    params: CharacterDisplaySurfaceProps = {},
  ): void | Promise<void> => {
    if (!reference || typeof reference.id !== 'string' || reference.id.length === 0) return
    const surfaces = runtime.host?.surfaces
    const invoke = method(surfaces, 'invoke')
    if (invoke) {
      try {
        return invoke.call(surfaces, reference, isRecord(params) ? params : {}) as void | Promise<void>
      } catch {
        // Fall through to legacy optional navigation members.
      }
    }
    return navigationFallback(runtime, reference, isRecord(params) ? params : {})
  }

  const openCharacter = (characterId: string): void | Promise<void> => {
    const normalizedId = id(characterId)
    if (!normalizedId) return
    return navigate({ kind: 'route', id: '/characters/:id' }, { id: normalizedId })
  }

  const openChat = (chatId: string): void | Promise<void> => {
    const normalizedId = id(chatId)
    if (!normalizedId) return
    return navigate({ kind: 'route', id: '/chat/:chatId' }, { id: normalizedId })
  }

  const openWorldBook = (bookId: string): void | Promise<void> => {
    const normalizedId = id(bookId)
    if (!normalizedId) return
    return navigate({ kind: 'modal', id: 'world_book_editor' }, { id: normalizedId })
  }

  const editCharacter = (characterId: string): void | Promise<void> => {
    const normalizedId = id(characterId)
    if (!normalizedId) return
    const edit = method(runtime.ui, 'editCharacter')
    if (edit) return edit.call(runtime.ui, normalizedId) as void | Promise<void>
    return openCharacter(normalizedId)
  }

  const toggleFavorite = (characterId: string): void | Promise<void> => {
    const normalizedId = id(characterId)
    if (!normalizedId) return
    const toggle = method(runtime.ui, 'toggleFavorite')
    if (toggle) return toggle.call(runtime.ui, normalizedId) as void | Promise<void>
    return undefined
  }

  const toggleBatch = (characterId: string, selected: boolean): void | Promise<void> => {
    const normalizedId = id(characterId)
    if (!normalizedId) return
    const toggle = method(runtime.ui, 'toggleBatch')
    if (toggle) return toggle.call(runtime.ui, normalizedId, selected === true) as void | Promise<void>
    return undefined
  }

  const subscribeNavigation = (listener: (payload: unknown) => void): Dispose => {
    if (typeof listener !== 'function') return NOOP
    let active = true
    const notify = (value: unknown) => {
      if (!active) return
      try { listener(value) } catch { /* isolate extension observers */ }
    }
    const registration = navigationRegistration(runtime.navigation, notify)
      ?? navigationRegistration(runtime.ui?.navigation, notify)
      ?? navigationRegistration(runtime.host?.navigation, notify)
      ?? navigationRegistration(runtime.events, notify)
      ?? subscribePort(runtime.ui?.events, 'on', 'navigation', notify)
    if (!registration) {
      active = false
      return NOOP
    }
    return once(() => {
      active = false
      registration()
    })
  }

  const components = runtime.components as CharacterDisplayComponents | undefined
  return {
    components,
    readActiveCharacter,
    getActiveCharacter: readActiveCharacter,
    subscribeActiveCharacter,
    getCharacter,
    applyBrowserDefaults,
    listThisChatCharacters,
    listAttachedWorldBooks,
    listChatsForCharacter,
    registerSettings,
    mountHostSurface,
    markOwnedRoot(root) {
      return markRoot(root, extensionUuid)
    },
    navigate,
    openCharacter,
    openChat,
    openWorldBook,
    editCharacter,
    toggleFavorite,
    toggleBatch,
    subscribeNavigation,
    onNavigation: subscribeNavigation,
  }
}

export type { SpindleFrontendContext }
