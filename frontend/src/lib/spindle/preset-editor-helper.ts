import type {
  SpindlePresetEditorDraft,
  SpindlePresetEditorExtensionState,
  SpindlePresetEditorScopedHelper,
  SpindlePresetEditorState,
} from './preset-editor-types'

type PresetMutator = (preset: SpindlePresetEditorDraft) => SpindlePresetEditorDraft

interface PresetEditorController {
  getState(): SpindlePresetEditorState
  setActiveTab(tabId: string): void
  updatePreset(mutator: PresetMutator, immediate: boolean): void
  flush(): Promise<void>
}

export interface PresetEditorScopedAccess {
  assertActive(): void
  trackSubscription(unsubscribe: () => void): () => void
}

const DEFAULT_STATE: SpindlePresetEditorState = {
  open: false,
  presetId: null,
  activeTabId: null,
  preset: null,
}

let controller: PresetEditorController | null = null
let snapshot: SpindlePresetEditorState = DEFAULT_STATE
const listeners = new Set<(state: SpindlePresetEditorState) => void>()

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

function cloneState(state: SpindlePresetEditorState): SpindlePresetEditorState {
  return {
    open: state.open,
    presetId: state.presetId,
    activeTabId: state.activeTabId,
    preset: state.preset ? clone(state.preset) : null,
  }
}

function publishState(next: SpindlePresetEditorState): void {
  snapshot = cloneState(next)
  for (const handler of listeners) {
    try { handler(cloneState(snapshot)) } catch { /* no-op */ }
  }
}

function assertOpenController(): PresetEditorController {
  if (!controller || !snapshot.open || !snapshot.preset) {
    throw new Error('PRESET_EDITOR_CLOSED: Preset editor is not open or has no selected preset')
  }
  return controller
}

export function setPresetEditorController(next: PresetEditorController | null): void {
  controller = next
  publishState(next ? next.getState() : DEFAULT_STATE)
}

export function syncPresetEditorState(next: SpindlePresetEditorState): void {
  publishState(next)
}

export function getPresetEditorState(): SpindlePresetEditorState {
  return cloneState(snapshot)
}

export function subscribePresetEditorState(
  handler: (state: SpindlePresetEditorState) => void,
): () => void {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}

export function updatePresetEditorDraft(mutator: PresetMutator, immediate = false): void {
  assertOpenController().updatePreset((draft) => mutator(clone(draft)), immediate)
}

export async function flushPresetEditorDraft(): Promise<void> {
  const activeController = assertOpenController()
  await activeController.flush()
  publishState(activeController.getState())
}

export function setPresetEditorActiveTab(tabId: string): void {
  if (!controller || !snapshot.open) return
  controller.setActiveTab(tabId)
}

function cloneExtensionState(
  state: SpindlePresetEditorState,
  extensionIdentifier: string,
): SpindlePresetEditorExtensionState {
  const draft = state.preset
  const metadata = draft && Object.hasOwn(draft.metadata, extensionIdentifier)
    ? clone(draft.metadata[extensionIdentifier])
    : undefined
  const promptVariableValues = draft?.metadata.promptVariables
  return {
    open: state.open,
    presetId: state.presetId,
    activeTabId: state.activeTabId,
    blocks: draft ? clone(draft.blocks) : [],
    promptVariableValues: promptVariableValues && typeof promptVariableValues === 'object'
      ? clone(promptVariableValues) as SpindlePresetEditorExtensionState['promptVariableValues']
      : {},
    metadata,
  }
}

function assertMetadataObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PRESET_EDITOR_INVALID_METADATA: Extension metadata must be an object')
  }
}

/**
 * Create the cooperative, extension-identifier-scoped editor facade. This
 * constrains supported API mutations; it is not a sandbox for same-origin code.
 */
export function createPresetEditorScopedHelper(
  extensionIdentifier: string,
  access: PresetEditorScopedAccess,
): SpindlePresetEditorScopedHelper {
  function applyScopedMetadataMutation(
    mutator: (current: unknown) => Record<string, unknown>,
    immediate = false,
  ): void {
    access.assertActive()
    updatePresetEditorDraft((draft) => {
      const nextMetadata = mutator(
        Object.hasOwn(draft.metadata, extensionIdentifier)
          ? clone(draft.metadata[extensionIdentifier])
          : undefined,
      )
      assertMetadataObject(nextMetadata)
      return {
        ...draft,
        metadata: {
          ...draft.metadata,
          [extensionIdentifier]: clone(nextMetadata),
        },
      }
    }, immediate)
  }

  return {
    getState(): SpindlePresetEditorExtensionState {
      access.assertActive()
      return cloneExtensionState(getPresetEditorState(), extensionIdentifier)
    },
    onChange(handler: (state: SpindlePresetEditorExtensionState) => void): () => void {
      access.assertActive()
      const unsubscribe = subscribePresetEditorState((state) => {
        handler(cloneExtensionState(state, extensionIdentifier))
      })
      return access.trackSubscription(unsubscribe)
    },
    setMetadata(value, options): void {
      assertMetadataObject(value)
      applyScopedMetadataMutation(() => value, options?.immediate === true)
    },
    updateMetadata(mutator, options): void {
      applyScopedMetadataMutation(mutator, options?.immediate === true)
    },
    activateBuiltinTab(tab): void {
      access.assertActive()
      if (tab !== 'blocks') throw new Error(`PRESET_EDITOR_UNKNOWN_BUILTIN_TAB:${tab}`)
      setPresetEditorActiveTab('preset')
    },
    flush(): Promise<void> {
      access.assertActive()
      return flushPresetEditorDraft()
    },
  }
}
