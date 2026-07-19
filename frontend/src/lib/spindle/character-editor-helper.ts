import type { SpindleCharacterEditorState } from './character-editor-types'

type ExtensionsMutator = (extensions: Record<string, any>) => Record<string, any>

interface CharacterEditorController {
  getState(): SpindleCharacterEditorState
  setActiveTab(tabId: string): void
  updateExtensions(mutator: ExtensionsMutator, immediate: boolean): void
  flush(): Promise<void>
}

const DEFAULT_STATE: SpindleCharacterEditorState = {
  open: false,
  characterId: null,
  activeTabId: null,
  extensions: {},
}

let controller: CharacterEditorController | null = null
let snapshot: SpindleCharacterEditorState = DEFAULT_STATE
const listeners = new Set<(state: SpindleCharacterEditorState) => void>()

function cloneExtensions(extensions: Record<string, any> | null | undefined): Record<string, any> {
  try {
    return structuredClone(extensions ?? {})
  } catch {
    try {
      return JSON.parse(JSON.stringify(extensions ?? {}))
    } catch {
      return { ...(extensions ?? {}) }
    }
  }
}

function cloneState(state: SpindleCharacterEditorState): SpindleCharacterEditorState {
  return {
    open: state.open,
    characterId: state.characterId,
    activeTabId: state.activeTabId,
    extensions: cloneExtensions(state.extensions),
  }
}

function publishState(next: SpindleCharacterEditorState): void {
  snapshot = cloneState(next)
  for (const handler of listeners) {
    try {
      handler(cloneState(snapshot))
    } catch {
      // no-op
    }
  }
}

function assertOpenController(): CharacterEditorController {
  if (!controller || !snapshot.open) {
    throw new Error('CHARACTER_EDITOR_CLOSED: Character editor is not open')
  }
  return controller
}

export function setCharacterEditorController(next: CharacterEditorController | null): void {
  controller = next
  publishState(next ? next.getState() : DEFAULT_STATE)
}

export function syncCharacterEditorState(next: SpindleCharacterEditorState): void {
  publishState(next)
}

export function getCharacterEditorState(): SpindleCharacterEditorState {
  return cloneState(snapshot)
}

export function subscribeCharacterEditorState(
  handler: (state: SpindleCharacterEditorState) => void,
): () => void {
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

export function updateCharacterEditorExtensions(
  mutator: ExtensionsMutator,
  immediate = false,
): void {
  assertOpenController().updateExtensions(mutator, immediate)
}

export function setCharacterEditorExtensions(
  extensions: Record<string, any>,
  immediate = false,
): void {
  const next = cloneExtensions(extensions)
  assertOpenController().updateExtensions(() => next, immediate)
}

export async function flushCharacterEditorExtensions(): Promise<void> {
  const activeController = assertOpenController()
  await activeController.flush()
  publishState(activeController.getState())
}

export function setCharacterEditorActiveTab(tabId: string): void {
  if (!controller || !snapshot.open) return
  controller.setActiveTab(tabId)
}
