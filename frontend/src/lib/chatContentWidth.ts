import { assertNever } from '@/lib/assertNever'
import type { SettingsSlice } from '@/types/store'

/**
 * The persisted chat content width mode.
 *
 * Derived from the settings store rather than redeclared so a new mode value cannot be
 * added to settings without the `resolveChatContentWidthPx` switch failing to typecheck.
 */
export type ChatWidthMode = SettingsSlice['chatWidthMode'] // 'full' | 'comfortable' | 'compact' | 'custom'

const CHAT_WIDTH_MODE_VALUES = Object.freeze({
  full: true,
  comfortable: true,
  compact: true,
  custom: true,
} satisfies Record<ChatWidthMode, true>)

function isChatWidthMode(value: unknown): value is ChatWidthMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(CHAT_WIDTH_MODE_VALUES, value)
}

/** Fixed-width presets, in layout px. One entry per mode that has a literal width; keys are unique. */
export const CHAT_CONTENT_WIDTH_PRESETS = Object.freeze({
  comfortable: 1000,
  compact: 760,
})

/**
 * The max-width `Chat_Content` carries, in layout px.
 *
 * `null` means unconstrained — the mode publishes no `--lumiverse-chat-content-width`,
 * so the content fills the chat body and the natural gutter is zero px wide.
 *
 * `custom` reports unconstrained for a non-finite or non-positive `customWidth` so a
 * corrupt settings row degrades to `full` behavior instead of a wrong margin.
 */
export function resolveChatContentWidthPx(mode: ChatWidthMode, customWidth: number): number | null {
  // Settings storage is opaque JSON and primitive rows are hydrated without runtime
  // validation. Keep an invalid or forward-version mode from throwing during ChatView's
  // render; the typed switch below remains exhaustive for modes this client understands.
  if (!isChatWidthMode(mode)) return null

  switch (mode) {
    case 'full':
      return null
    case 'comfortable':
      return CHAT_CONTENT_WIDTH_PRESETS.comfortable
    case 'compact':
      return CHAT_CONTENT_WIDTH_PRESETS.compact
    case 'custom':
      return Number.isFinite(customWidth) && customWidth > 0 ? customWidth : null
    default:
      return assertNever(mode)
  }
}

/**
 * The content width `getPortraitLayoutReclaim` must be handed, in layout px.
 *
 * An unconstrained mode has a zero-width gutter, which the reclaim math expresses as
 * `contentWidth === bodyWidth`.
 */
export function resolveChatContentWidthForReclaim(
  mode: ChatWidthMode,
  customWidth: number,
  bodyWidth: number,
): number {
  return resolveChatContentWidthPx(mode, customWidth) ?? bodyWidth
}
