/**
 * Local character-editor Spindle UI typings.
 *
 * Core can adopt the new API shape immediately, before the published
 * `lumiverse-spindle-types` package version used by this repo is bumped.
 */
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export interface SpindleCharacterEditorTabOptions {
  id: string
  title: string
}

export interface SpindleCharacterEditorTabHandle {
  root: HTMLElement
  tabId: string
  setTitle(title: string): void
  activate(): void
  destroy(): void
  onActivate(handler: () => void): () => void
}

export interface SpindleCharacterEditorState {
  open: boolean
  characterId: string | null
  activeTabId: string | null
  extensions: Record<string, any>
}

export interface SpindleCharacterEditorSaveOptions {
  immediate?: boolean
}

export interface SpindleCharacterEditorHelper {
  getState(): SpindleCharacterEditorState
  onChange(handler: (state: SpindleCharacterEditorState) => void): () => void
  setExtensions(extensions: Record<string, any>, options?: SpindleCharacterEditorSaveOptions): void
  updateExtensions(
    mutator: (extensions: Record<string, any>) => Record<string, any>,
    options?: SpindleCharacterEditorSaveOptions,
  ): void
  flush(): Promise<void>
}

export type SpindleCharacterEditorUI = SpindleFrontendContext['ui'] & {
  registerCharacterEditorTab(options: SpindleCharacterEditorTabOptions): SpindleCharacterEditorTabHandle
  characterEditor: SpindleCharacterEditorHelper
}
