import { getCharacterGridMetrics, resolveCharacterDisplaySettings } from './settings-model'
import type {
  CharacterDisplayChatSummary,
  CharacterDisplaySelection,
  CharacterDisplaySettings,
  CharacterDisplaySurface,
} from './types'

type JsonRecord = Record<string, unknown>
type UnknownFunction = (...args: unknown[]) => unknown

type CharacterDisplayWorldBookSummary = { readonly id: string; readonly name: string }
type ComponentHandle = {
  readonly update?: (props: JsonRecord) => void
  readonly destroy?: () => void
}

type SurfaceHandle = ComponentHandle & {
  readonly on?: (event: string, handler: (payload: unknown) => void) => (() => void)
}

type Cleanup = () => void

function applyCardTargetMetrics(target: HTMLElement, settings: CharacterDisplaySettings): void {
  const metrics = getCharacterGridMetrics(settings)
  target.style.minWidth = `${metrics.cardMinWidth}px`
  // `rowHeight` includes the grid gap; a standalone preview card does not.
  target.style.height = `${metrics.imageHeight + metrics.footerHeight}px`
}

type RuntimeNodes = {
  readonly settingsSection: HTMLElement
  readonly controls: HTMLElement
  readonly scope: HTMLElement
  readonly cardTarget: HTMLElement
  readonly characterDetails: HTMLElement
  readonly worldBookStatus: HTMLElement
  readonly worldBookList: HTMLUListElement
  readonly thisChatChip: HTMLButtonElement
  readonly libraryTarget: HTMLElement
  readonly chatStatus: HTMLElement
  readonly chatList: HTMLUListElement
}

type ControlBinding = {
  readonly handle?: ComponentHandle
  readonly updateFallback?: (value: unknown) => void
  readonly destroyFallback?: Cleanup
}

export interface CharacterDisplayRuntimeOptions {
  readonly root: HTMLElement
  readonly settings: CharacterDisplaySettings
  readonly homepageSettings?: CharacterDisplaySettings
  readonly characterTabSettings?: CharacterDisplaySettings
  readonly surface?: CharacterDisplaySurface
  /** The host adapter deliberately remains structural so the runtime is usable with test adapters. */
  readonly adapter: unknown
  readonly onSettingsChange?: (
    surface: CharacterDisplaySurface,
    settings: CharacterDisplaySettings,
  ) => void | Promise<void>
  readonly onSelectionChange?: (selection: CharacterDisplaySelection | null) => void
  readonly scopeLabel?: string | null
  readonly document?: Document
}

export interface CharacterDisplayRuntime {
  updateSettings(settings: CharacterDisplaySettings): void
  updateSelection(selection: CharacterDisplaySelection | null | undefined): void
  updateScope(scopeLabel: string | null | undefined): void
  destroy(): void
}

const CARD_SURFACE_ID = 'character_card'
const GRID_SURFACE_ID = 'character_library_grid'
const CONTROL_METHODS = ['mountSwitch', 'mountRangeSlider', 'mountSelect', 'mountMultiSelect'] as const

type ControlMethod = (typeof CONTROL_METHODS)[number]

const DENSITY_OPTIONS = [
  ['compact', 'Compact'],
  ['balanced', 'Balanced'],
  ['large', 'Large'],
  ['custom', 'Custom'],
] as const
const FOOTER_OPTIONS = [
  ['compact', 'Compact'],
  ['balanced', 'Balanced'],
  ['spacious', 'Spacious'],
] as const
const SURFACE_OPTIONS = [
  ['homepage', 'Homepage'],
  ['characters-tab', 'Characters tab'],
] as const
const VIEW_OPTIONS = [
  ['grid', 'Grid'],
  ['single', 'Single'],
  ['list', 'List'],
] as const
const SORT_OPTIONS = [
  ['name', 'Name'],
  ['recent', 'Recent'],
  ['created', 'Created'],
  ['shuffle', 'Shuffle'],
] as const
const FILTER_OPTIONS = [
  ['characters', 'Characters'],
  ['favorites', 'Favorites'],
  ['groups', 'Groups'],
] as const
const METADATA_OPTIONS = [
  ['creator', 'Creator'],
  ['tags', 'Tags'],
] as const

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function cloneSettings(settings: CharacterDisplaySettings): CharacterDisplaySettings {
  return { ...settings, visibleMetadata: [...settings.visibleMetadata] }
}

function methodOn(value: unknown, name: string): { readonly owner: JsonRecord; readonly fn: UnknownFunction } | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[name]
  return typeof candidate === 'function'
    ? { owner: value, fn: candidate as UnknownFunction }
    : undefined
}

function firstMethod(values: readonly unknown[], name: string): { readonly owner: JsonRecord; readonly fn: UnknownFunction } | undefined {
  for (const value of values) {
    const found = methodOn(value, name)
    if (found) return found
  }
  return undefined
}

function methodResult(values: readonly unknown[], name: string, ...args: unknown[]): unknown {
  const found = firstMethod(values, name)
  if (!found) return undefined
  try {
    return found.fn.call(found.owner, ...args)
  } catch {
    return undefined
  }
}

function selectionId(selection: CharacterDisplaySelection | null | undefined): string | null {
  const id = stringValue(selection?.characterId)
  return id ?? null
}

function selectionName(selection: CharacterDisplaySelection | null | undefined): string | undefined {
  return stringValue(selection?.characterName)
}

function characterRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function characterName(value: unknown, fallback: string): string {
  return stringValue(characterRecord(value)?.name) ?? fallback
}

function boundedPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return text.slice(0, 280)
}

function chatId(value: unknown): string | undefined {
  return stringValue(isRecord(value) ? value.id : undefined)
}

function chatName(value: unknown): string {
  return stringValue(isRecord(value) ? value.name : undefined) ?? 'Untitled chat'
}

function chatMessageCount(value: unknown): number {
  const record = isRecord(value) ? value : undefined
  return Math.max(0, Math.floor(numberValue(record?.messageCount ?? record?.message_count, 0)))
}

function chatPreview(value: unknown): string {
  const record = isRecord(value) ? value : undefined
  return boundedPreview(record?.lastMessagePreview ?? record?.last_message_preview)
}

function chatUpdatedAt(value: unknown): number {
  const record = isRecord(value) ? value : undefined
  return numberValue(record?.updatedAt ?? record?.updated_at, 0)
}

function normalizedChat(value: unknown): CharacterDisplayChatSummary | undefined {
  const id = chatId(value)
  if (!id) return undefined
  return {
    id,
    name: chatName(value),
    messageCount: chatMessageCount(value),
    lastMessagePreview: chatPreview(value),
    updatedAt: chatUpdatedAt(value),
    ...(isRecord(value) && typeof value.isGroup === 'boolean' ? { isGroup: value.isGroup } : {}),
  }
}

function makeOptionList(options: readonly (readonly [string, string])[]): Array<{ value: string; label: string }> {
  return options.map(([value, label]) => ({ value, label }))
}

function setText(element: HTMLElement, value: string): void {
  element.textContent = value
}

function safeDestroy(handle: ComponentHandle | undefined): void {
  try { handle?.destroy?.() } catch { /* host teardown is best effort */ }
}

function safeUpdate(handle: ComponentHandle | undefined, props: JsonRecord): void {
  try { handle?.update?.(props) } catch { /* stale host handles are ignored */ }
}

export function createCharacterDisplayRuntime(options: CharacterDisplayRuntimeOptions): CharacterDisplayRuntime {
  const root = options.root
  const document = options.document ?? root.ownerDocument
  const adapter = options.adapter
  let homepageSettings = cloneSettings(options.homepageSettings ?? options.settings)
  let characterTabSettings = cloneSettings(options.characterTabSettings ?? options.settings)
  let editingSurface: CharacterDisplaySurface = options.surface ?? 'characters-tab'
  let settings = resolveCharacterDisplaySettings({
    surface: editingSurface,
    homepageSettings,
    characterTabSettings,
  }).display
  let scopeLabel = options.scopeLabel ?? null
  let selection: CharacterDisplaySelection | null = null
  let activeId: string | null = null
  let mounted = false
  let destroyed = false
  let generation = 0
  let libraryGeneration = 0
  let abortController: AbortController | undefined
  let libraryAbortController: AbortController | undefined
  let surface: SurfaceHandle | undefined
  let gridSurface: SurfaceHandle | undefined
  let nodes: RuntimeNodes | undefined
  let activeCharacter: unknown = null
  let chats: readonly CharacterDisplayChatSummary[] = []
  let worldBooks: readonly CharacterDisplayWorldBookSummary[] = []
  let thisChatCharacters: readonly unknown[] = []
  let thisChatActive = false
  const controls = new Map<string, ControlBinding>()
  const cleanups: Cleanup[] = []
  const surfaceCleanups: Cleanup[] = []
  const gridSurfaceCleanups: Cleanup[] = []
  let chatCleanups: Cleanup[] = []
  let worldBookCleanups: Cleanup[] = []

  const componentCandidates = (): readonly unknown[] => {
    const candidates: unknown[] = []
    if (isRecord(adapter)) {
      if (adapter.components) candidates.push(adapter.components)
      if (isRecord(adapter.ctx) && adapter.ctx.components) candidates.push(adapter.ctx.components)
      candidates.push(adapter)
    }
    return candidates
  }

  const findComponent = (name: ControlMethod): { readonly owner: JsonRecord; readonly fn: UnknownFunction } | undefined => {
    return firstMethod(componentCandidates(), name)
  }

  const clearChatListeners = (): void => {
    while (chatCleanups.length > 0) {
      const cleanup = chatCleanups.pop()
      try { cleanup?.() } catch { /* listener cleanup is isolated */ }
    }
  }

  const clearWorldBookListeners = (): void => {
    while (worldBookCleanups.length > 0) {
      const cleanup = worldBookCleanups.pop()
      try { cleanup?.() } catch { /* listener cleanup is isolated */ }
    }
  }

  const createField = (labelText: string, key: string): { field: HTMLElement; target: HTMLElement; label: HTMLElement } => {
    const field = document.createElement('div')
    field.dataset.characterDisplayField = key
    field.style.minWidth = '0'
    field.style.display = 'grid'
    field.style.gap = '6px'

    const label = document.createElement('span')
    label.dataset.characterDisplayLabel = key
    label.textContent = labelText

    const target = document.createElement('div')
    target.dataset.characterDisplayControl = key
    target.style.minWidth = '0'
    target.setAttribute('aria-label', labelText)

    field.append(label, target)
    return { field, target, label }
  }

  const mountFallbackSwitch = (target: HTMLElement, label: string, value: boolean, onChange: (value: boolean) => void): ControlBinding => {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = value
    input.setAttribute('aria-label', label)
    input.dataset.characterDisplayFallback = 'switch'
    const listener = (): void => onChange(input.checked)
    input.addEventListener('change', listener)
    target.replaceChildren(input)
    return {
      updateFallback(next) { input.checked = Boolean(next) },
      destroyFallback() { input.removeEventListener('change', listener) },
    }
  }

  const mountFallbackRange = (
    target: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): ControlBinding => {
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = '1'
    input.value = String(value)
    input.setAttribute('aria-label', label)
    input.dataset.characterDisplayFallback = 'range'
    const listener = (): void => onChange(Number(input.value))
    input.addEventListener('input', listener)
    input.addEventListener('change', listener)
    target.replaceChildren(input)
    return {
      updateFallback(next) { input.value = String(numberValue(next, value)) },
      destroyFallback() {
        input.removeEventListener('input', listener)
        input.removeEventListener('change', listener)
      },
    }
  }

  const mountFallbackSelect = (
    target: HTMLElement,
    label: string,
    value: string | readonly string[],
    choices: readonly (readonly [string, string])[],
    multiple: boolean,
    onChange: (value: string | string[]) => void,
  ): ControlBinding => {
    const select = document.createElement('select')
    select.setAttribute('aria-label', label)
    select.dataset.characterDisplayFallback = multiple ? 'multi-select' : 'select'
    if (multiple) select.multiple = true
    for (const [choiceValue, choiceLabel] of choices) {
      const option = document.createElement('option')
      option.value = choiceValue
      option.textContent = choiceLabel
      select.append(option)
    }
    const listener = (): void => {
      if (multiple) onChange([...select.selectedOptions].map(option => option.value))
      else onChange(select.value)
    }
    select.addEventListener('change', listener)
    target.replaceChildren(select)
    const apply = (next: unknown): void => {
      const source = multiple && Array.isArray(next) ? next.map(String) : [String(next ?? '')]
      const values = new Set(source)
      for (const option of [...select.options]) option.selected = values.has(option.value)
    }
    apply(value)
    return {
      updateFallback: apply,
      destroyFallback() { select.removeEventListener('change', listener) },
    }
  }

  const mountControl = (
    key: string,
    methodName: ControlMethod,
    target: HTMLElement,
    props: JsonRecord,
    fallback: () => ControlBinding,
  ): void => {
    const method = findComponent(methodName)
    if (!method) {
      controls.set(key, fallback())
      return
    }
    try {
      const mountedHandle = method.fn.call(method.owner, target, props)
      controls.set(key, { handle: isRecord(mountedHandle) ? mountedHandle as ComponentHandle : undefined })
    } catch {
      controls.set(key, fallback())
    }
  }

  const applyCharacterDetails = (): void => {
    if (!nodes) return
    nodes.characterDetails.replaceChildren()
    const id = activeId
    if (!id) {
      setText(nodes.characterDetails, 'No active character')
      return
    }
    const name = characterName(activeCharacter, selectionName(selection) ?? id)
    const heading = document.createElement('strong')
    heading.textContent = name
    nodes.characterDetails.append(heading)
    const record = characterRecord(activeCharacter)
    const creator = stringValue(record?.creator)
    const tags = Array.isArray(record?.tags)
      ? record.tags.filter(item => typeof item === 'string').slice(0, settings.maxVisibleTags) as string[]
      : []
    if (creator && settings.visibleMetadata.includes('creator')) {
      const creatorLine = document.createElement('span')
      creatorLine.textContent = `Creator: ${creator}`
      nodes.characterDetails.append(creatorLine)
    }
    if (settings.visibleMetadata.includes('tags') && tags.length > 0) {
      const tagsLine = document.createElement('span')
      tagsLine.textContent = `Tags: ${tags.join(', ')}`
      nodes.characterDetails.append(tagsLine)
    }
    nodes.characterDetails.dataset.characterId = id
  }

  const renderChats = (status: string): void => {
    if (!nodes) return
    clearChatListeners()
    nodes.chatList.replaceChildren()
    setText(nodes.chatStatus, status)
    nodes.chatStatus.dataset.state = status.toLowerCase().startsWith('failed') ? 'error' : 'ready'
    for (const chat of chats.slice(0, 100)) {
      const item = document.createElement('li')
      item.dataset.characterDisplayChat = chat.id
      item.style.minHeight = '48px'
      item.style.display = 'grid'
      item.style.gap = '2px'

      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = chat.name
      button.setAttribute('aria-label', `Open chat ${chat.name}`)
      button.dataset.characterDisplayChatAction = 'open'
      const listener = (): void => {
        if (destroyed || !activeId) return
        methodResult([adapter], 'openChat', chat.id, activeId)
      }
      button.addEventListener('click', listener)
      chatCleanups.push(() => button.removeEventListener('click', listener))

      const meta = document.createElement('span')
      meta.textContent = `${chat.messageCount} messages`
      meta.dataset.characterDisplayChatMeta = 'count'
      const preview = document.createElement('span')
      preview.textContent = boundedPreview(chat.lastMessagePreview)
      preview.dataset.characterDisplayChatPreview = 'true'
      item.append(button, meta, preview)
      nodes.chatList.append(item)
    }
  }
  const renderWorldBooks = (status: string): void => {
    if (!nodes) return
    clearWorldBookListeners()
    nodes.worldBookList.replaceChildren()
    setText(nodes.worldBookStatus, status)
    nodes.worldBookStatus.dataset.state = status.toLowerCase().startsWith('failed') ? 'error' : 'ready'
    for (const book of worldBooks.slice(0, 100)) {
      const item = document.createElement('li')
      item.dataset.characterDisplayWorldBook = book.id
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = book.name
      button.setAttribute('aria-label', `Open world book ${book.name}`)
      button.dataset.characterDisplayWorldBookAction = 'open'
      const listener = (): void => {
        if (destroyed) return
        methodResult([adapter], 'openWorldBook', book.id)
      }
      button.addEventListener('click', listener)
      worldBookCleanups.push(() => button.removeEventListener('click', listener))
      item.append(button)
      nodes.worldBookList.append(item)
    }
  }


  const clearSurfaceListeners = (): void => {
    while (surfaceCleanups.length > 0) {
      const cleanup = surfaceCleanups.pop()
      try { cleanup?.() } catch { /* listener cleanup is isolated */ }
    }
  }

  const destroySurface = (): void => {
    clearSurfaceListeners()
    safeDestroy(surface)
    surface = undefined
  }
  const clearGridSurfaceListeners = (): void => {
    while (gridSurfaceCleanups.length > 0) {
      const cleanup = gridSurfaceCleanups.pop()
      try { cleanup?.() } catch { /* listener cleanup is isolated */ }
    }
  }

  const destroyGridSurface = (): void => {
    clearGridSurfaceListeners()
    safeDestroy(gridSurface)
    gridSurface = undefined
  }


  const invokeSurfaceNavigation = (event: string, payload: unknown): void => {
    const record = isRecord(payload) ? payload : undefined
    const id = stringValue(record?.characterId) ?? activeId
    if (!id) return
    if (event === 'select') {
      const nextSelection: CharacterDisplaySelection = {
        ...(selection ?? { characterId: null }),
        characterId: id,
        surface: editingSurface,
      }
      selection = nextSelection
      try { options.onSelectionChange?.(nextSelection) } catch { /* host callback isolation */ }
    } else if (event === 'open') methodResult([adapter], 'openCharacter', id)
    else if (event === 'edit') methodResult([adapter], 'editCharacter', id)
    else if (event === 'toggleFavorite') methodResult([adapter], 'toggleFavorite', id)
    else if (event === 'toggleBatch') methodResult([adapter], 'toggleBatch', id, record?.selected === true)
  }

  const mountCharacterSurface = (id: string): void => {
    if (!nodes) return
    const method = firstMethod([adapter], 'mountHostSurface')
    if (!method) return
    try {
      const mountedSurface = method.fn.call(method.owner, nodes.cardTarget, CARD_SURFACE_ID, {
        characterId: id,
        batchMode: false,
        isSelected: false,
      })
      if (!isRecord(mountedSurface)) return
      surface = mountedSurface as SurfaceHandle
      if (typeof surface.on !== 'function') return
      for (const event of ['open', 'edit', 'toggleFavorite', 'toggleBatch']) {
        try {
          const unsubscribe = surface.on(event, payload => {
            if (!destroyed && id === activeId) invokeSurfaceNavigation(event, payload)
          })
          if (typeof unsubscribe === 'function') surfaceCleanups.push(unsubscribe)
        } catch { /* unavailable event channels are ignored */ }
      }
    } catch {
      setText(nodes.characterDetails, 'Character preview unavailable')
    }
  }
  const gridProps = (): JsonRecord => ({
    characters: thisChatCharacters.slice(0, 100),
    filterTab: settings.defaultFilter,
    sortField: settings.defaultSort,
    sortDirection: 'desc',
    viewMode: settings.viewMode,
    ...(selection?.scope ? { scope: selection.scope } : {}),
    ...(activeId ? { selectedCharacterId: activeId } : {}),
  })

  const mountThisChatGrid = (): void => {
    if (!nodes || !thisChatActive) return
    if (gridSurface) {
      safeUpdate(gridSurface, gridProps())
      return
    }
    const method = firstMethod([adapter], 'mountHostSurface')
    if (!method) return
    try {
      const mountedSurface = method.fn.call(method.owner, nodes.libraryTarget, GRID_SURFACE_ID, gridProps())
      if (!isRecord(mountedSurface)) return
      gridSurface = mountedSurface as SurfaceHandle
      if (typeof gridSurface.on !== 'function') return
      for (const event of ['select', 'open', 'edit', 'toggleFavorite', 'toggleBatch']) {
        try {
          const unsubscribe = gridSurface.on(event, payload => {
            if (!destroyed && thisChatActive) invokeSurfaceNavigation(event, payload)
          })
          if (typeof unsubscribe === 'function') gridSurfaceCleanups.push(unsubscribe)
        } catch { /* unavailable event channels are ignored */ }
      }
    } catch {
      nodes.libraryTarget.textContent = 'This chat characters unavailable'
    }
  }

  const beginThisChatLoad = (): void => {
    if (!nodes || !thisChatActive) return
    libraryGeneration += 1
    const requestGeneration = libraryGeneration
    libraryAbortController?.abort()
    libraryAbortController = typeof AbortController === 'undefined' ? undefined : new AbortController()
    thisChatCharacters = []
    destroyGridSurface()
    nodes.libraryTarget.replaceChildren()
    nodes.thisChatChip.setAttribute('aria-busy', 'true')
    const request = methodResult([adapter], 'listThisChatCharacters', libraryAbortController?.signal)
    if (!request || typeof (request as Promise<unknown>).then !== 'function') {
      nodes.thisChatChip.removeAttribute('aria-busy')
      nodes.libraryTarget.textContent = 'This chat characters unavailable'
      return
    }
    Promise.resolve(request).then(value => {
      if (destroyed || !mounted || !thisChatActive || requestGeneration !== libraryGeneration) return
      thisChatCharacters = Array.isArray(value) ? value.slice(0, 100) : []
      nodes?.thisChatChip.removeAttribute('aria-busy')
      mountThisChatGrid()
    }).catch(() => {
      if (destroyed || !mounted || !thisChatActive || requestGeneration !== libraryGeneration) return
      nodes?.thisChatChip.removeAttribute('aria-busy')
      if (nodes) nodes.libraryTarget.textContent = 'Failed to load this chat characters'
    })
  }


  const beginSelectionLoad = (nextSelection: CharacterDisplaySelection | null): void => {
    if (!nodes) return
    const id = selectionId(nextSelection)
    const previousId = activeId
    activeId = id
    selection = nextSelection
    if (previousId === id) {
      applyCharacterDetails()
      mountThisChatGrid()
      return
    }

    generation += 1
    const requestGeneration = generation
    abortController?.abort()
    abortController = typeof AbortController === 'undefined' ? undefined : new AbortController()
    destroySurface()
    activeCharacter = null
    chats = []
    worldBooks = []
    nodes.cardTarget.replaceChildren()
    if (!id) {
      applyCharacterDetails()
      renderChats('No active character')
      renderWorldBooks('No active character')
      return
    }

    applyCardTargetMetrics(nodes.cardTarget, settings)
    mountCharacterSurface(id)
    applyCharacterDetails()
    renderChats('Loading chats...')
    renderWorldBooks('Loading attached world books...')
    if (thisChatActive) beginThisChatLoad()

    const signal = abortController?.signal
    const characterRequest = methodResult([adapter], 'getCharacter', id)
    if (characterRequest && typeof (characterRequest as Promise<unknown>).then === 'function') {
      Promise.resolve(characterRequest).then(value => {
        if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
        activeCharacter = value
        applyCharacterDetails()
        const worldBookRequest = methodResult([adapter], 'listAttachedWorldBooks', value, signal)
        if (!worldBookRequest || typeof (worldBookRequest as Promise<unknown>).then !== 'function') {
          renderWorldBooks('Attached world books unavailable')
          return
        }
        Promise.resolve(worldBookRequest).then(result => {
          if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
          const rows = Array.isArray(result) ? result : []
          worldBooks = rows.filter((row): row is CharacterDisplayWorldBookSummary => (
            isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'
          )).slice(0, 100)
          renderWorldBooks(worldBooks.length > 0
            ? `${worldBooks.length} attached world book${worldBooks.length === 1 ? '' : 's'}`
            : 'No attached world books')
        }).catch(() => {
          if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
          worldBooks = []
          renderWorldBooks('Failed to load attached world books')
        })
      }).catch(() => {
        if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
        setText(nodes?.characterDetails ?? root, 'Character details unavailable')
        renderWorldBooks('Attached world books unavailable')
      })
    }

    const chatRequest = methodResult([adapter], 'listChatsForCharacter', id, signal)
    if (chatRequest && typeof (chatRequest as Promise<unknown>).then === 'function') {
      Promise.resolve(chatRequest).then(value => {
        if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
        const rows = Array.isArray(value) ? value : []
        chats = rows.map(normalizedChat).filter((chat): chat is CharacterDisplayChatSummary => chat !== undefined).slice(0, 100)
        renderChats(chats.length > 0 ? `${chats.length} chat${chats.length === 1 ? '' : 's'}` : 'No chats found')
      }).catch(() => {
        if (destroyed || !mounted || requestGeneration !== generation || activeId !== id) return
        chats = []
        renderChats('Failed to load chats')
      })
    } else {
      renderChats('Chats unavailable')
    }
  }

  const applySettings = (): void => {
    if (!nodes) return
    root.dataset.enabled = String(settings.enabled)
    root.dataset.density = settings.density
    root.dataset.footerMode = settings.footerMode
    root.dataset.viewMode = settings.viewMode
    root.dataset.defaultSort = settings.defaultSort
    root.dataset.defaultFilter = settings.defaultFilter
    root.style.setProperty('--character-display-thumbnail-width', `${settings.thumbnailWidth}px`)
    root.style.setProperty('--character-display-thumbnail-height', `${settings.thumbnailHeight}px`)
    applyCardTargetMetrics(nodes.cardTarget, settings)
    const updates: Record<string, unknown> = {
      surface: editingSurface,
      useHomepageSettings: settings.useHomepageSettings,
      thumbnailWidth: settings.thumbnailWidth,
      thumbnailHeight: settings.thumbnailHeight,
      tagRows: settings.tagRows,
      maxVisibleTags: settings.maxVisibleTags,
      density: settings.density,
      footerMode: settings.footerMode,
      viewMode: settings.viewMode,
      defaultSort: settings.defaultSort,
      defaultFilter: settings.defaultFilter,
      visibleMetadata: [...settings.visibleMetadata],
    }
    for (const [key, value] of Object.entries(updates)) {
      const binding = controls.get(key)
      if (!binding) continue
      safeUpdate(binding.handle, { value, checked: value })
      try { binding.updateFallback?.(value) } catch { /* fallback controls are isolated */ }
    }
    applyCharacterDetails()
    mountThisChatGrid()
  }

  const updateSettings = (nextSettings: CharacterDisplaySettings): void => {
    if (destroyed) return
    if (editingSurface === 'homepage') homepageSettings = cloneSettings(nextSettings)
    else characterTabSettings = cloneSettings(nextSettings)
    settings = resolveCharacterDisplaySettings({
      surface: editingSurface,
      homepageSettings,
      characterTabSettings,
    }).display
    if (!settings.enabled) {
      teardownMount()
      return
    }
    if (!mounted) mount()
    applySettings()
  }

  const commitSettings = (patch: Partial<CharacterDisplaySettings>): void => {
    if (destroyed) return
    const source = editingSurface === 'homepage' ? homepageSettings : characterTabSettings
    const next = cloneSettings({
      ...source,
      ...patch,
      visibleMetadata: patch.visibleMetadata ? [...patch.visibleMetadata] : [...source.visibleMetadata],
    })
    if (editingSurface === 'homepage') homepageSettings = next
    else characterTabSettings = next
    settings = resolveCharacterDisplaySettings({
      surface: editingSurface,
      homepageSettings,
      characterTabSettings,
    }).display
    try {
      const result = options.onSettingsChange?.(editingSurface, cloneSettings(next))
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined)
      }
    } catch { /* host callback isolation */ }
    applySettings()
  }

  const mountSettingsControls = (settingsSection: HTMLElement): HTMLElement => {
    const controlsRoot = document.createElement('div')
    controlsRoot.dataset.characterDisplayControls = 'true'
    controlsRoot.style.display = 'grid'
    controlsRoot.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))'
    controlsRoot.style.gap = '12px'
    controlsRoot.style.minWidth = '0'
    const surfaceField = createField('Settings for', 'surface')
    mountControl('surface', 'mountSelect', surfaceField.target, {
      value: editingSurface,
      options: makeOptionList(SURFACE_OPTIONS),
      ariaLabel: 'Settings for',
      onChange: (value: string) => {
        const nextSurface: CharacterDisplaySurface = value === 'homepage' ? 'homepage' : 'characters-tab'
        if (nextSurface === editingSurface) return
        editingSurface = nextSurface
        settings = resolveCharacterDisplaySettings({
          surface: editingSurface,
          homepageSettings,
          characterTabSettings,
        }).display
        teardownMount()
        mount()
        beginSelectionLoad(selection)
      },
    }, () => mountFallbackSelect(surfaceField.target, 'Settings for', editingSurface, SURFACE_OPTIONS, false, value => {
      const nextSurface: CharacterDisplaySurface = value === 'homepage' ? 'homepage' : 'characters-tab'
      if (nextSurface === editingSurface) return
      editingSurface = nextSurface
      settings = resolveCharacterDisplaySettings({
        surface: editingSurface,
        homepageSettings,
        characterTabSettings,
      }).display
      teardownMount()
      mount()
      beginSelectionLoad(selection)
    }))
    controlsRoot.append(surfaceField.field)


    const useHomepage = createField('Use homepage settings', 'useHomepageSettings')
    mountControl('useHomepageSettings', 'mountSwitch', useHomepage.target, {
      checked: settings.useHomepageSettings,
      ariaLabel: 'Use homepage settings',
      onChange: (value: boolean) => commitSettings({ useHomepageSettings: Boolean(value) }),
    }, () => mountFallbackSwitch(useHomepage.target, 'Use homepage settings', settings.useHomepageSettings, value => commitSettings({ useHomepageSettings: value })))
    controlsRoot.append(useHomepage.field)

    const width = createField('Thumbnail width', 'thumbnailWidth')
    mountControl('thumbnailWidth', 'mountRangeSlider', width.target, {
      label: 'Thumbnail width', min: 96, max: 360, step: 1, integer: true, value: settings.thumbnailWidth,
      onCommit: (value: number) => commitSettings({ thumbnailWidth: value }),
    }, () => mountFallbackRange(width.target, 'Thumbnail width', settings.thumbnailWidth, 96, 360, value => commitSettings({ thumbnailWidth: value })))
    controlsRoot.append(width.field)

    const height = createField('Thumbnail height', 'thumbnailHeight')
    mountControl('thumbnailHeight', 'mountRangeSlider', height.target, {
      label: 'Thumbnail height', min: 120, max: 520, step: 1, integer: true, value: settings.thumbnailHeight,
      onCommit: (value: number) => commitSettings({ thumbnailHeight: value }),
    }, () => mountFallbackRange(height.target, 'Thumbnail height', settings.thumbnailHeight, 120, 520, value => commitSettings({ thumbnailHeight: value })))
    controlsRoot.append(height.field)

    const tagRows = createField('Tag rows', 'tagRows')
    mountControl('tagRows', 'mountRangeSlider', tagRows.target, {
      label: 'Tag rows', min: 0, max: 5, step: 1, integer: true, value: settings.tagRows,
      onCommit: (value: number) => commitSettings({ tagRows: value }),
    }, () => mountFallbackRange(tagRows.target, 'Tag rows', settings.tagRows, 0, 5, value => commitSettings({ tagRows: value })))
    controlsRoot.append(tagRows.field)

    const maxTags = createField('Max visible tags', 'maxVisibleTags')
    mountControl('maxVisibleTags', 'mountRangeSlider', maxTags.target, {
      label: 'Max visible tags', min: 1, max: 20, step: 1, integer: true, value: settings.maxVisibleTags,
      onCommit: (value: number) => commitSettings({ maxVisibleTags: value }),
    }, () => mountFallbackRange(maxTags.target, 'Max visible tags', settings.maxVisibleTags, 1, 20, value => commitSettings({ maxVisibleTags: value })))
    controlsRoot.append(maxTags.field)

    const density = createField('Density', 'density')
    mountControl('density', 'mountSelect', density.target, {
      value: settings.density, options: makeOptionList(DENSITY_OPTIONS), ariaLabel: 'Density',
      onChange: (value: string) => commitSettings({ density: value as CharacterDisplaySettings['density'] }),
    }, () => mountFallbackSelect(density.target, 'Density', settings.density, DENSITY_OPTIONS, false, value => commitSettings({ density: String(value) as CharacterDisplaySettings['density'] })))
    controlsRoot.append(density.field)

    const footer = createField('Footer', 'footerMode')
    mountControl('footerMode', 'mountSelect', footer.target, {
      value: settings.footerMode, options: makeOptionList(FOOTER_OPTIONS), ariaLabel: 'Footer',
      onChange: (value: string) => commitSettings({ footerMode: value as CharacterDisplaySettings['footerMode'] }),
    }, () => mountFallbackSelect(footer.target, 'Footer', settings.footerMode, FOOTER_OPTIONS, false, value => commitSettings({ footerMode: String(value) as CharacterDisplaySettings['footerMode'] })))
    controlsRoot.append(footer.field)

    const view = createField('View', 'viewMode')
    mountControl('viewMode', 'mountSelect', view.target, {
      value: settings.viewMode, options: makeOptionList(VIEW_OPTIONS), ariaLabel: 'View',
      onChange: (value: string) => commitSettings({ viewMode: value as CharacterDisplaySettings['viewMode'] }),
    }, () => mountFallbackSelect(view.target, 'View', settings.viewMode, VIEW_OPTIONS, false, value => commitSettings({ viewMode: String(value) as CharacterDisplaySettings['viewMode'] })))
    controlsRoot.append(view.field)

    const sort = createField('Sort', 'defaultSort')
    mountControl('defaultSort', 'mountSelect', sort.target, {
      value: settings.defaultSort, options: makeOptionList(SORT_OPTIONS), ariaLabel: 'Sort',
      onChange: (value: string) => commitSettings({ defaultSort: value as CharacterDisplaySettings['defaultSort'] }),
    }, () => mountFallbackSelect(sort.target, 'Sort', settings.defaultSort, SORT_OPTIONS, false, value => commitSettings({ defaultSort: String(value) as CharacterDisplaySettings['defaultSort'] })))
    controlsRoot.append(sort.field)

    const filter = createField('Filter', 'defaultFilter')
    mountControl('defaultFilter', 'mountSelect', filter.target, {
      value: settings.defaultFilter, options: makeOptionList(FILTER_OPTIONS), ariaLabel: 'Filter',
      onChange: (value: string) => commitSettings({ defaultFilter: value as CharacterDisplaySettings['defaultFilter'] }),
    }, () => mountFallbackSelect(filter.target, 'Filter', settings.defaultFilter, FILTER_OPTIONS, false, value => commitSettings({ defaultFilter: String(value) as CharacterDisplaySettings['defaultFilter'] })))
    controlsRoot.append(filter.field)

    const metadata = createField('Visible metadata', 'visibleMetadata')
    mountControl('visibleMetadata', 'mountMultiSelect', metadata.target, {
      value: [...settings.visibleMetadata], options: makeOptionList(METADATA_OPTIONS), ariaLabel: 'Visible metadata',
      onChange: (value: readonly string[]) => commitSettings({ visibleMetadata: value.filter(item => item === 'creator' || item === 'tags') as CharacterDisplaySettings['visibleMetadata'] }),
    }, () => mountFallbackSelect(metadata.target, 'Visible metadata', [...settings.visibleMetadata], METADATA_OPTIONS, true, value => {
      const values = Array.isArray(value) ? value : [value]
      commitSettings({ visibleMetadata: values.filter(item => item === 'creator' || item === 'tags') as CharacterDisplaySettings['visibleMetadata'] })
    }))
    controlsRoot.append(metadata.field)

    settingsSection.append(controlsRoot)
    return controlsRoot
  }

  const makeNodes = (): RuntimeNodes => {
    root.replaceChildren()
    root.dataset.lumiverseModule = 'character_display'
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', 'Character display settings')
    root.style.display = 'grid'
    root.style.gap = '16px'
    root.style.minWidth = '0'

    const settingsSection = document.createElement('section')
    settingsSection.dataset.characterDisplaySettings = 'true'
    settingsSection.setAttribute('aria-label', 'Character display controls')
    const settingsHeading = document.createElement('h2')
    settingsHeading.textContent = 'Character display'
    settingsHeading.style.margin = '0'
    settingsSection.append(settingsHeading)
    const controlsRoot = mountSettingsControls(settingsSection)

    const scopeRow = document.createElement('div')
    scopeRow.dataset.characterDisplayScopeRow = 'true'
    const scopeTitle = document.createElement('span')
    scopeTitle.textContent = 'Library scope: '
    const scope = document.createElement('span')
    scope.dataset.characterDisplayScope = 'true'
    scope.setAttribute('aria-readonly', 'true')
    scope.textContent = scopeLabel ?? 'Unavailable'
    scopeRow.append(scopeTitle, scope)
    settingsSection.append(scopeRow)

    const previewSection = document.createElement('section')
    previewSection.dataset.characterDisplayPreview = 'true'
    previewSection.setAttribute('aria-label', 'Active character preview')
    const previewHeading = document.createElement('h2')
    previewHeading.textContent = 'Active character preview'
    previewHeading.style.margin = '0'
    const cardTarget = document.createElement('div')
    cardTarget.dataset.characterDisplayCardSurface = 'true'
    applyCardTargetMetrics(cardTarget, settings)
    cardTarget.style.minHeight = '120px'
    cardTarget.style.display = 'grid'
    cardTarget.style.placeItems = 'stretch'
    cardTarget.style.overflow = 'hidden'
    const characterDetails = document.createElement('div')
    characterDetails.dataset.characterDisplayCharacter = 'true'
    characterDetails.style.display = 'grid'
    characterDetails.style.gap = '4px'
    const worldBookStatus = document.createElement('p')
    worldBookStatus.dataset.characterDisplayWorldBookStatus = 'true'
    worldBookStatus.setAttribute('aria-live', 'polite')
    const worldBookList = document.createElement('ul')
    worldBookList.dataset.characterDisplayWorldBooks = 'true'
    worldBookList.setAttribute('aria-label', 'Attached world books')
    previewSection.append(previewHeading, cardTarget, characterDetails, worldBookStatus, worldBookList)

    const librarySection = document.createElement('section')
    librarySection.dataset.characterDisplayLibrary = 'true'
    librarySection.setAttribute('aria-label', 'Character library filters')
    const libraryHeading = document.createElement('h2')
    libraryHeading.textContent = 'Character library'
    const thisChatChip = document.createElement('button')
    thisChatChip.type = 'button'
    thisChatChip.textContent = 'This chat'
    thisChatChip.setAttribute('aria-label', 'Show characters in this chat')
    thisChatChip.setAttribute('aria-pressed', String(thisChatActive))
    thisChatChip.dataset.characterDisplayThisChat = 'true'
    const libraryTarget = document.createElement('div')
    libraryTarget.dataset.characterDisplayGridSurface = 'true'
    const onThisChat = (): void => {
      if (destroyed) return
      thisChatActive = !thisChatActive
      thisChatChip.setAttribute('aria-pressed', String(thisChatActive))
      if (thisChatActive) {
        beginThisChatLoad()
        return
      }
      libraryGeneration += 1
      libraryAbortController?.abort()
      libraryAbortController = undefined
      thisChatCharacters = []
      destroyGridSurface()
      libraryTarget.replaceChildren()
    }
    thisChatChip.addEventListener('click', onThisChat)
    cleanups.push(() => thisChatChip.removeEventListener('click', onThisChat))
    librarySection.append(libraryHeading, thisChatChip, libraryTarget)

    const chatsSection = document.createElement('section')
    chatsSection.dataset.characterDisplayChats = 'true'
    chatsSection.setAttribute('aria-label', 'Character chats')
    const chatsHeading = document.createElement('h2')
    chatsHeading.textContent = 'Chats'
    chatsHeading.style.margin = '0'
    const chatStatus = document.createElement('p')
    chatStatus.dataset.characterDisplayChatStatus = 'true'
    chatStatus.setAttribute('aria-live', 'polite')
    const chatList = document.createElement('ul')
    chatList.dataset.characterDisplayChatList = 'true'
    chatList.style.display = 'grid'
    chatList.style.gap = '8px'
    chatList.style.maxHeight = '320px'
    chatList.style.overflow = 'auto'
    chatList.style.margin = '0'
    chatList.style.padding = '0'
    chatsSection.append(chatsHeading, chatStatus, chatList)

    root.append(settingsSection, previewSection, librarySection, chatsSection)
    return {
      settingsSection,
      controls: controlsRoot,
      scope,
      cardTarget,
      characterDetails,
      worldBookStatus,
      worldBookList,
      thisChatChip,
      libraryTarget,
      chatStatus,
      chatList,
    }
  }

  const teardownMount = (): void => {
    abortController?.abort()
    abortController = undefined
    libraryAbortController?.abort()
    libraryAbortController = undefined
    generation += 1
    libraryGeneration += 1
    destroySurface()
    destroyGridSurface()
    clearChatListeners()
    clearWorldBookListeners()
    for (const binding of controls.values()) {
      safeDestroy(binding.handle)
      try { binding.destroyFallback?.() } catch { /* fallback teardown is isolated */ }
    }
    controls.clear()
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      try { cleanup?.() } catch { /* listener teardown is isolated */ }
    }
    if (mounted) {
      root.replaceChildren()
      root.removeAttribute('data-lumiverse-module')
      root.removeAttribute('data-enabled')
      root.removeAttribute('data-density')
      root.removeAttribute('data-footer-mode')
      root.removeAttribute('data-view-mode')
      root.removeAttribute('data-default-sort')
      root.removeAttribute('data-default-filter')
      for (const property of ['display', 'gap', 'min-width', '--character-display-thumbnail-width', '--character-display-thumbnail-height']) {
        root.style.removeProperty(property)
      }
    }
    nodes = undefined
    mounted = false
    activeCharacter = null
    chats = []
    worldBooks = []
    thisChatCharacters = []
    activeId = null
  }

  const mount = (): void => {
    if (destroyed || mounted || !settings.enabled) return
    nodes = makeNodes()
    mounted = true
    applySettings()
  }

  const runtime: CharacterDisplayRuntime = {
    updateSettings(nextSettings) {
      updateSettings(nextSettings)
    },
    updateSelection(nextSelection) {
      if (destroyed) return
      selection = nextSelection ?? null
      if (!settings.enabled) return
      if (!mounted) mount()
      if (mounted) beginSelectionLoad(selection)
    },
    updateScope(nextScope) {
      if (destroyed) return
      scopeLabel = nextScope ?? null
      if (nodes) nodes.scope.textContent = scopeLabel ?? 'Unavailable'
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      teardownMount()
    },
  }

  if (settings.enabled) mount()

  return runtime
}

export const createRuntime = createCharacterDisplayRuntime
