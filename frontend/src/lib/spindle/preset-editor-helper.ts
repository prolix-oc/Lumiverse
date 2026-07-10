import type { SpindlePresetEditorDraft, SpindlePresetEditorState } from './preset-editor-types'

type PresetMutator = (preset: SpindlePresetEditorDraft) => SpindlePresetEditorDraft

interface PresetEditorController {
  getState(): SpindlePresetEditorState
  setActiveTab(tabId: string): void
  updatePreset(mutator: PresetMutator, immediate: boolean): void
  flush(): Promise<void>
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
