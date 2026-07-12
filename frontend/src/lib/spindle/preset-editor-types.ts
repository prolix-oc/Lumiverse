import type { PromptBlockDTO, PromptVariableValuesDTO, SpindleFrontendContext } from 'lumiverse-spindle-types'

export interface SpindlePresetEditorTabOptions {
  id: string
  title: string
}

export interface SpindlePresetEditorTabHandle {
  root: HTMLElement
  tabId: string
  setTitle(title: string): void
  activate(): void
  destroy(): void
  onActivate(handler: () => void): () => void
}

export type SpindlePresetEditorBuiltinTabId = 'blocks'

export interface SpindlePresetEditorToolbarItemOptions {
  id: string
  ariaLabel: string
}

export interface SpindlePresetEditorToolbarItemHandle {
  readonly root: HTMLElement
  readonly itemId: string
  setVisible(visible: boolean): void
  destroy(): void
}

export interface SpindlePresetEditorDraft {
  id: string
  name: string
  blocks: PromptBlockDTO[]
  parameters: Record<string, unknown>
  prompts: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface SpindlePresetEditorState {
  open: boolean
  presetId: string | null
  activeTabId: string | null
  preset: SpindlePresetEditorDraft | null
}

export interface SpindlePresetEditorSaveOptions {
  immediate?: boolean
}

export interface SpindlePresetEditorHelper {
  getState(): SpindlePresetEditorState
  onChange(handler: (state: SpindlePresetEditorState) => void): () => void
  updatePreset(
    mutator: (preset: SpindlePresetEditorDraft) => SpindlePresetEditorDraft,
    options?: SpindlePresetEditorSaveOptions,
  ): void
  flush(): Promise<void>
}

export interface SpindlePresetEditorExtensionState {
  readonly open: boolean
  readonly presetId: string | null
  readonly activeTabId: string | null
  /** A detached array cloned from the host draft. */
  blocks: PromptBlockDTO[]
  /** Detached prompt-variable values cloned from the host draft. */
  promptVariableValues: PromptVariableValuesDTO
  /** Structured clone of the calling extension's host-managed metadata namespace. */
  readonly metadata: unknown
}

export interface SpindlePresetEditorScopedHelper {
  getState(): SpindlePresetEditorExtensionState
  onChange(handler: (state: SpindlePresetEditorExtensionState) => void): () => void
  setMetadata(value: Record<string, unknown>, options?: SpindlePresetEditorSaveOptions): void
  updateMetadata(
    mutator: (current: unknown) => Record<string, unknown>,
    options?: SpindlePresetEditorSaveOptions,
  ): void
  activateBuiltinTab(tab: SpindlePresetEditorBuiltinTabId): void
  flush(): Promise<void>
}

export interface SpindlePresetEditorToolbarUI {
  registerPresetEditorToolbarItem(
    options: SpindlePresetEditorToolbarItemOptions,
  ): SpindlePresetEditorToolbarItemHandle
}

export interface SpindlePresetEditorExtensionHelper {
  readonly extension: SpindlePresetEditorScopedHelper
}

export type SpindlePresetEditorUI = SpindleFrontendContext['ui']
  & SpindlePresetEditorToolbarUI
  & {
    registerPresetEditorTab(options: SpindlePresetEditorTabOptions): SpindlePresetEditorTabHandle
    presetEditor: SpindlePresetEditorHelper & SpindlePresetEditorExtensionHelper
  }
