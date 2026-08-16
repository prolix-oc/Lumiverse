import type { SuiteModule, SuiteModuleContext } from '../../suite'
import { requireSuiteSettings, type SuiteSettingsAPI } from '../../shared/settings'
import { PermissionBroker } from '../../shared/permissions'
import { readExtensionInstallationId } from '../../shared/public-sdk'
import {
  CHARACTER_LIBRARY_SCOPE_MODULE_ID,
  CHARACTER_LIBRARY_SCOPE_SETTINGS_KEY,
  defaultCharacterLibraryScopeSettings,
  normalizeCharacterLibraryScopeSettings,
  type CharacterLibraryScope,
  type CharacterLibraryScopeChangedPayload,
  type CharacterLibraryScopeMetadataPayload,
  type CharacterLibraryScopeSettings,
} from './types'

const MODULE_ID = CHARACTER_LIBRARY_SCOPE_MODULE_ID
const SETTINGS_KEY = CHARACTER_LIBRARY_SCOPE_SETTINGS_KEY
const CHARACTER_EDITOR_TAB_ID = 'character_library_scope'
const LIBRARY_SCOPE_EXTENSION_KEY = '_lumiverse_library_scope'

type JsonRecord = Record<string, unknown>
type Method = (...args: unknown[]) => unknown


type Settings = CharacterLibraryScopeSettings
type ChangedPayload = CharacterLibraryScopeChangedPayload
type MetadataPayload = CharacterLibraryScopeMetadataPayload

const DEFAULT_SETTINGS = defaultCharacterLibraryScopeSettings()

const MODULE_STYLES = String.raw`
[data-lumiverse-module="character_library_scope"]{box-sizing:border-box;color:var(--lumiverse-text,inherit);font:inherit}
[data-lumiverse-module="character_library_scope"] [data-lumiverse-scope-header]{align-items:center;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}
[data-lumiverse-module="character_library_scope"] [data-lumiverse-scope-title]{font-weight:600;margin-inline-end:auto}
[data-lumiverse-module="character_library_scope"] [data-lumiverse-scope-badge]{background:var(--lumiverse-surface-raised,#252332);border:1px solid var(--lumiverse-border-subtle,#5b5870);border-radius:999px;font-size:.8em;padding:2px 8px}
[data-lumiverse-module="character_library_scope"] [data-lumiverse-scope-facet]{font:inherit;min-height:30px}
`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function method(candidate: JsonRecord | undefined, name: string): Method | undefined {
  const value = candidate?.[name]
  return typeof value === 'function' ? (value as Method).bind(candidate) : undefined
}

function scopeValue(value: unknown, fallback: CharacterLibraryScope): CharacterLibraryScope {
  return value === 'mine' || value === 'shared' ? value : fallback
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}


function sameSettings(left: Settings, right: Settings): boolean {
  return left.enabled === right.enabled
    && left.scope === right.scope
    && left.showBadge === right.showBadge
    && left.showFacet === right.showFacet
}

function sameStoredSettings(value: unknown, expected: Settings): boolean {
  try { return JSON.stringify(value) === JSON.stringify(expected) } catch { return false }
}

function extensionUuid(context: SuiteModuleContext): string | undefined {
  return readExtensionInstallationId(context.host)
}

function uiRecord(context: SuiteModuleContext): JsonRecord | undefined {
  const ui = context.host.ui
  return isRecord(ui) ? ui : undefined
}




function elementLike(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { append?: unknown; remove?: unknown; replaceChildren?: unknown }
  return typeof candidate.append === 'function'
    && typeof candidate.remove === 'function'
    && typeof candidate.replaceChildren === 'function'
}

function markOwned(node: HTMLElement, installedUuid: string | undefined): void {
  node.setAttribute('data-lumiverse-module', MODULE_ID)
  if (!installedUuid) return
  node.setAttribute('data-spindle-extension-root', installedUuid)
  node.setAttribute('data-spindle-ext', installedUuid)
  node.setAttribute('data-lumiverse-installed-uuid', installedUuid)
}


export function createCharacterLibraryScopeModule(): SuiteModule {
  let running = false
  let starting = false
  let context: SuiteModuleContext | undefined
  let settingsApi: SuiteSettingsAPI | undefined
  let current: Settings = { ...DEFAULT_SETTINGS }
  let stopSettingsWatch: (() => void) | undefined
  let lifecycleGeneration = 0
  let activeRoot: HTMLElement | undefined
  let activeTab: JsonRecord | undefined
  let activeDisposers: Array<() => void> = []
  let stylesActive = false
  let editorSessionKey = ''
  let editorSessionGeneration = 0
  let scopeWriteGeneration = 0

  const emitMetadata = (extra: Partial<MetadataPayload> = {}) => {
    const payload: MetadataPayload = {
      scope: extra.scope ?? current.scope,
      showBadge: extra.showBadge ?? current.showBadge,
      showFacet: extra.showFacet ?? current.showFacet,
      ...(extra.characterId === undefined ? {} : { characterId: extra.characterId }),
      ...(extra.characterName === undefined ? {} : { characterName: extra.characterName }),
      ...(extra.count === undefined ? {} : { count: extra.count }),
    }
    context?.bus?.emit('library-scope/metadata', payload)
  }

  const emitChanged = (characterId: string, scope: CharacterLibraryScope, previousScope: CharacterLibraryScope) => {
    const payload: ChangedPayload = { characterId, scope, previousScope }
    context?.bus?.emit('library-scope/changed', payload)
  }

  const clearResources = () => {
    lifecycleGeneration += 1
    scopeWriteGeneration += 1
    editorSessionKey = ''
    editorSessionGeneration += 1
    for (const dispose of activeDisposers.splice(0).reverse()) {
      try { dispose() } catch { /* cleanup is best effort */ }
    }
    try { method(activeTab, 'destroy')?.() } catch { /* no-op */ }
    activeTab = undefined
    try { activeRoot?.remove() } catch { /* no-op */ }
    activeRoot = undefined
    if (stylesActive) {
      context?.styles.clear()
      stylesActive = false
    }
  }

  const persistSettings = (nextValue: Settings) => {
    current = normalizeCharacterLibraryScopeSettings(nextValue)
    void settingsApi?.set(SETTINGS_KEY, current).catch(() => undefined)
    if (!running) return
    clearResources()
    if (current.enabled) activate()
  }

  const renderSettings = (root: HTMLElement, disposers: Array<() => void>, activationContext: SuiteModuleContext) => {
    root.replaceChildren()
    const doc = root.ownerDocument
    const section = doc.createElement('section')
    markOwned(section, extensionUuid(activationContext))
    const heading = doc.createElement('h3')
    heading.textContent = 'Character library scope'
    section.append(heading)

    const scopeLabel = doc.createElement('label')
    scopeLabel.textContent = 'Default library'
    const scopeSelect = doc.createElement('select')
    scopeSelect.dataset.lumiverseScopeFacet = 'settings'
    for (const scope of ['mine', 'shared'] as const) {
      const option = doc.createElement('option')
      option.value = scope
      option.textContent = scope === 'shared' ? 'Shared' : 'Mine'
      option.selected = current.scope === scope
      scopeSelect.append(option)
    }
    const onScope = () => {
      const nextScope = scopeValue(scopeSelect.value, current.scope)
      if (nextScope !== current.scope) persistSettings({ ...current, scope: nextScope })
    }
    scopeSelect.addEventListener('change', onScope)
    disposers.push(() => scopeSelect.removeEventListener('change', onScope))
    scopeLabel.append(scopeSelect)
    section.append(scopeLabel)

    for (const [key, labelText] of [['showBadge', 'Show scope badge'], ['showFacet', 'Show scope facet']] as const) {
      const label = doc.createElement('label')
      const checkbox = doc.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = current[key]
      const onChange = () => persistSettings({ ...current, [key]: checkbox.checked })
      checkbox.addEventListener('change', onChange)
      disposers.push(() => checkbox.removeEventListener('change', onChange))
      label.append(checkbox, doc.createTextNode(labelText))
      section.append(label)
    }
    root.append(section)
    disposers.push(() => section.remove())
  }

  const activate = () => {
    if (!context || !running || !current.enabled || activeRoot) return
    const activationContext = context
    const activationGeneration = lifecycleGeneration
    const isCurrent = () => running
      && current.enabled
      && context === activationContext
      && lifecycleGeneration === activationGeneration
    const ui = uiRecord(activationContext)
    const registerCharacterEditorTab = method(ui, 'registerCharacterEditorTab')
    const editor = isRecord(ui?.characterEditor) ? ui.characterEditor : undefined
    const getState = method(editor, 'getState')
    const onChange = method(editor, 'onChange')
    const updateExtensions = method(editor, 'updateExtensions')
    if (!registerCharacterEditorTab || !editor || !getState || !onChange || !updateExtensions) return

    let tabValue: unknown
    try {
      tabValue = registerCharacterEditorTab({ id: CHARACTER_EDITOR_TAB_ID, title: 'Library scope' })
    } catch {
      return
    }
    if (!isRecord(tabValue)) return
    const tabRoot = tabValue.root
    if (!elementLike(tabRoot)) {
      try { method(tabValue, 'destroy')?.() } catch { /* no-op */ }
      return
    }

    const root = tabRoot
    activeRoot = root
    activeTab = tabValue
    markOwned(root, extensionUuid(activationContext))
    root.dataset.lumiverseScopeRoot = 'true'
    activationContext.styles.add(MODULE_STYLES, { scope: 'root' })
    stylesActive = true
    const disposers: Array<() => void> = []
    activeDisposers = disposers

    const readEditorState = (): JsonRecord | undefined => {
      try {
        const value = getState()
        return isRecord(value) ? value : undefined
      } catch {
        return undefined
      }
    }

    const syncEditorSession = (state: JsonRecord | undefined): string => {
      const characterId = stringValue(state?.characterId)
      const key = state?.open === true && characterId ? characterId : ''
      if (key !== editorSessionKey) {
        editorSessionKey = key
        editorSessionGeneration += 1
      }
      return key
    }

    let renderEditor: (stateValue?: unknown) => void = () => undefined

    const persistScope = async (
      characterId: string,
      scope: CharacterLibraryScope,
      previousScope: CharacterLibraryScope,
      expectedSessionGeneration: number,
      expectedWriteGeneration: number,
    ): Promise<void> => {
      if (!isCurrent()) return
      const editorState = readEditorState()
      if (editorState?.open !== true || stringValue(editorState.characterId) !== characterId) return
      if (editorSessionGeneration !== expectedSessionGeneration || editorSessionKey !== characterId) return

      let granted = false
      try {
        granted = await new PermissionBroker(activationContext.host).ensure(
          'characters',
          `change character ${characterId} to the ${scope} library`,
        )
      } catch {
        renderEditor(editorSessionGeneration === expectedSessionGeneration && editorSessionKey === characterId ? editorState : undefined)
        return
      }
      if (!granted || !isCurrent() || editorSessionGeneration !== expectedSessionGeneration || editorSessionKey !== characterId || scopeWriteGeneration !== expectedWriteGeneration) {
        renderEditor(editorSessionGeneration === expectedSessionGeneration && editorSessionKey === characterId ? editorState : undefined)
        return
      }

      try {
        updateExtensions((extensionsValue: unknown) => {
          const extensions = isRecord(extensionsValue) ? extensionsValue : {}
          return { ...extensions, [LIBRARY_SCOPE_EXTENSION_KEY]: scope }
        }, { immediate: true })
        const flush = method(editor, 'flush')
        if (flush) await flush()
      } catch {
        renderEditor()
        return
      }
      if (!isCurrent() || editorSessionGeneration !== expectedSessionGeneration || editorSessionKey !== characterId || scopeWriteGeneration !== expectedWriteGeneration) {
        renderEditor()
        return
      }
      emitChanged(characterId, scope, previousScope)
      emitMetadata({ characterId, scope })
      renderEditor()
    }

    renderEditor = (stateValue?: unknown) => {
      root.replaceChildren()
      const editorState = isRecord(stateValue) ? stateValue : readEditorState()
      const characterId = syncEditorSession(editorState)
      if (editorState?.open !== true || !characterId) return
      const extensions = isRecord(editorState.extensions) ? editorState.extensions : {}
      const scope = scopeValue(extensions[LIBRARY_SCOPE_EXTENSION_KEY], current.scope)
      root.dataset.lumiverseLibraryScope = scope

      const section = root.ownerDocument.createElement('section')
      markOwned(section, extensionUuid(activationContext))
      const header = root.ownerDocument.createElement('header')
      markOwned(header, extensionUuid(activationContext))
      header.dataset.lumiverseScopeHeader = 'true'
      const title = root.ownerDocument.createElement('span')
      title.dataset.lumiverseScopeTitle = 'true'
      title.textContent = 'Character library scope'
      header.append(title)

      if (current.showBadge) {
        const badge = root.ownerDocument.createElement('span')
        badge.dataset.lumiverseScopeBadge = 'true'
        badge.textContent = scope === 'shared' ? 'Shared' : 'Mine'
        badge.setAttribute('aria-label', `Library scope: ${scope}`)
        header.append(badge)
      }

      if (current.showFacet) {
        const scopeLabel = root.ownerDocument.createElement('label')
        scopeLabel.textContent = 'Library scope'
        const scopeSelect = root.ownerDocument.createElement('select')
        scopeSelect.dataset.lumiverseScopeFacet = 'character-editor'
        scopeSelect.setAttribute('aria-label', 'Character library scope')
        for (const optionScope of ['mine', 'shared'] as const) {
          const option = root.ownerDocument.createElement('option')
          option.value = optionScope
          option.textContent = optionScope === 'shared' ? 'Shared' : 'Mine'
          option.selected = optionScope === scope
          scopeSelect.append(option)
        }
        const expectedSessionGeneration = editorSessionGeneration
        const onScope = () => {
          if (!isCurrent()) return
          const nextScope = scopeValue(scopeSelect.value, scope)
          if (nextScope === scope) return
          scopeSelect.disabled = true
          const expectedWriteGeneration = ++scopeWriteGeneration
          void persistScope(characterId, nextScope, scope, expectedSessionGeneration, expectedWriteGeneration)
        }
        scopeSelect.addEventListener('change', onScope)
        disposers.push(() => scopeSelect.removeEventListener('change', onScope))
        scopeLabel.append(scopeSelect)
        header.append(scopeLabel)
      }

      section.append(header)
      root.append(section)
    }

    try {
      const unsubscribe = onChange((stateValue: unknown) => {
        if (isCurrent()) renderEditor(stateValue)
      })
      if (typeof unsubscribe === 'function') disposers.push(unsubscribe as () => void)
    } catch {
      // Older hosts may not expose character-editor change subscriptions.
    }
    renderEditor()

    emitMetadata()
  }

  const applySettings = (nextValue: unknown) => {
    const next = normalizeCharacterLibraryScopeSettings(nextValue)
    if (sameSettings(current, next)) return
    current = next
    if (!running) return
    clearResources()
    if (current.enabled) activate()
  }

  return {
    id: MODULE_ID,
    async start(moduleContext?: SuiteModuleContext) {
      if (running || starting) return
      starting = true
      const startGeneration = ++lifecycleGeneration
      context = moduleContext
      settingsApi = requireSuiteSettings(moduleContext ?? {})
      const saved = await settingsApi.get<unknown>(SETTINGS_KEY)
      if (startGeneration !== lifecycleGeneration || context !== moduleContext) {
        starting = false
        return
      }
      current = normalizeCharacterLibraryScopeSettings(saved)
      if (!sameStoredSettings(saved, current)) {
        await settingsApi.set(SETTINGS_KEY, current)
        if (startGeneration !== lifecycleGeneration || context !== moduleContext) {
          starting = false
          return
        }
      }
      running = true
      starting = false
      stopSettingsWatch = settingsApi.watch<unknown>(SETTINGS_KEY, value => {
        if (running) applySettings(value)
      })
      if (current.enabled) activate()
    },
    stop() {
      if (!running && !starting) {
        clearResources()
        stopSettingsWatch?.()
        stopSettingsWatch = undefined
        context = undefined
        settingsApi = undefined
        return
      }
      running = false
      starting = false
      lifecycleGeneration += 1
      stopSettingsWatch?.()
      stopSettingsWatch = undefined
      clearResources()
      context = undefined
      settingsApi = undefined
    },
  }
}
