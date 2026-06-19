/**
 * Component Override System
 *
 * Provides the infrastructure for users to replace built-in components
 * with custom TSX implementations.  Each interpreted override receives a
 * stable flattened props contract. Callback props may only be used as
 * allowlisted symbolic event bindings such as onClick={actions.copy}.
 *
 * Rich/interactive content (formatted markdown, reasoning, attachments) is not
 * exposed as a string — the sandbox forbids dangerouslySetInnerHTML. Instead,
 * overrides render it through built-in slot tags (`<Content />`, `<Reasoning />`,
 * `<Attachments />`) which the runtime fills with the real host components.
 */

export interface ComponentOverride {
  css: string
  tsx: string
  enabled: boolean
}

// ── Props contracts ─────────────────────────────────────────────────

/** sm (~300px) / lg (~700px) / full (original resolution) variants of one image. */
export interface OverrideAvatarTiers {
  sm: string | null
  lg: string | null
  full: string | null
}

/**
 * Both avatar variants at every size tier, so themes can pick exactly what they
 * need: a `cropped` 1:1 square (good for round/square frames) or the `original`
 * uploaded aspect ratio (good for full-bleed portraits).
 */
export interface OverrideAvatar {
  /** User-cropped 1:1 square variant (falls back to the original when no crop exists). */
  cropped: OverrideAvatarTiers
  /** Original uploaded image at its native aspect ratio. */
  original: OverrideAvatarTiers
}

export interface OverrideMessageInfo {
  id: string
  index: number
  sendDate: number
  isUser: boolean
  displayName: string
  /** First character of `displayName`, uppercased ('?' when empty). Handy for avatar fallbacks — the AST sandbox cannot slice strings itself. */
  initial: string
  /** Convenience: cropped square at the tier the active layout uses. See `avatar` for full control. */
  avatarUrl: string | null
  /** Convenience: original aspect ratio at full resolution. See `avatar` for full control. */
  fullAvatarUrl: string | null
  /** Cropped/original avatar URLs across all size tiers. */
  avatar: OverrideAvatar
  isHidden: boolean
  isStreaming: boolean
  isLastMessage: boolean
  tokenCount: number | null
}

export interface OverrideContent {
  /**
   * Raw markdown source. To render the fully-formatted message (markdown, code
   * highlighting, macros, interactivity) place the `<Content />` slot tag
   * instead — it renders the real built-in content component.
   */
  raw: string
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
