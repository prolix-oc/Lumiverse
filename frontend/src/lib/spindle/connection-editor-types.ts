/**
 * Local connection-editor Spindle UI typings.
 *
 * The connection editor deliberately exposes only the credential-free editor
 * identity.  The published package can adopt this shape independently of the
 * host's implementation.
 */
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export interface SpindleConnectionEditorTabOptions {
  id: string
  title: string
  iconSvg?: string
  order?: number
}

export interface SpindleConnectionEditorTabHandle {
  root: HTMLElement
  tabId: string
  setTitle(title: string): void
  destroy(): void
}

export interface SpindleConnectionEditorState {
  profileId: string | null
  provider: string | null
  isNew: boolean
}

export interface SpindleConnectionEditorHelper {
  getEditedProfileId(): string | null
  getState(): SpindleConnectionEditorState
  onChange(handler: (state: SpindleConnectionEditorState) => void): () => void
  onSaved(handler: (profileId: string) => void): () => void
}

export type SpindleConnectionEditorUI = SpindleFrontendContext['ui'] & {
  registerConnectionEditorTab(
    options: SpindleConnectionEditorTabOptions,
  ): SpindleConnectionEditorTabHandle
  connectionEditor: SpindleConnectionEditorHelper
}
