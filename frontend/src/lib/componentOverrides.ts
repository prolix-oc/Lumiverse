/**
 * Component Override System
 *
 * Provides the infrastructure for users to replace built-in components
 * with custom TSX implementations.  Each interpreted override receives a
 * stable flattened props contract. Callback props may only be used as
 * allowlisted symbolic event bindings such as onClick={actions.copy}.
 */

export interface ComponentOverride {
  css: string
  tsx: string
  enabled: boolean
}

// ── Props contracts ─────────────────────────────────────────────────

export interface OverrideMessageInfo {
  id: string
  index: number
  sendDate: number
  isUser: boolean
  displayName: string
  avatarUrl: string | null
  isHidden: boolean
  isStreaming: boolean
  isLastMessage: boolean
  tokenCount: number | null
}

export interface OverrideContent {
  /** Raw markdown source */
  raw: string
  /** Pre-rendered HTML (markdown, code highlighting, macros already applied) */
  html: string
}

export interface OverrideReasoning {
  raw: string
  duration: number | null
  isStreaming: boolean
}

export interface OverrideSwipes {
  current: number
  total: number
}

export interface OverrideAttachment {
  type: 'image' | 'audio'
  imageId: string
  mimeType: string
  filename: string
}

export interface OverrideEditing {
  active: boolean
  content: string
  reasoning: string
  setContent: (s: string) => void
  setReasoning: (s: string) => void
  save: () => void
  cancel: () => void
}

export interface OverrideActions {
  copy: () => void
  edit: () => void
  delete: () => void
  toggleHidden: () => void
  fork: () => void
  promptBreakdown: () => void
  swipeLeft: () => void
  swipeRight: () => void
}

/** Full props contract for BubbleMessage / MinimalMessage overrides. */
export interface MessageOverrideProps {
  message: OverrideMessageInfo
  content: OverrideContent
  reasoning: OverrideReasoning | null
  swipes: OverrideSwipes
  attachments: OverrideAttachment[]
  editing: OverrideEditing
  actions: OverrideActions
  /** CSS module class names from the original component */
  styles: Record<string, string>
}
