import type { PromptBlockDTO, SpindleFrontendContext } from 'lumiverse-spindle-types'

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

export type SpindlePresetEditorUI = SpindleFrontendContext['ui'] & {
  registerPresetEditorTab(options: SpindlePresetEditorTabOptions): SpindlePresetEditorTabHandle
  presetEditor: SpindlePresetEditorHelper
}
