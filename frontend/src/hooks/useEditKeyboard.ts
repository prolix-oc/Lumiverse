import { useEffect } from 'react'
import { useStore } from '@/store'

/**
 * Global keyboard listener for ArrowUp message editing.
 * - ArrowUp: edits the last assistant message; repeated presses walk up through older assistant messages.
 * - Shift+ArrowUp: edits the last user message; repeated presses walk up through older user messages.
 *
 * Walks from the currently-edited message's index, so switching kinds (Up vs Shift+Up)
 * uses the current edit target as the reference point.
 */
export default function useEditKeyboard(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp') return

      // Block if any non-Shift modifier is held
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const state = useStore.getState()

      // Guard conditions (mirror useSwipeKeyboard)
      if (!state.activeChatId) return
      if (state.isStreaming) return
      if (state.activeModal) return
      if (state.commandPaletteOpen) return
      if (state.messageSelectMode) return

      // Don't intercept when focused on input elements
      const active = document.activeElement
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable
      )) return

      // Don't intercept when text is selected
      const selection = window.getSelection()?.toString()
      if (selection && selection.length > 0) return

      const targetIsUser = e.shiftKey
      const messages = state.messages
      if (messages.length === 0) return

      // Reference index: either the currently-edited message, or one past the end
      const currentIdx = state.editingMessageId
        ? messages.findIndex((m) => m.id === state.editingMessageId)
        : -1
      const refIdx = currentIdx >= 0 ? currentIdx : messages.length

      // Walk backward looking for the previous message of the target kind
      let targetMessage: typeof messages[number] | undefined
      for (let i = refIdx - 1; i >= 0; i--) {
        if (messages[i].is_user === targetIsUser) {
          targetMessage = messages[i]
          break
        }
      }

      if (!targetMessage) return

      e.preventDefault()
      state.setEditingMessageId(targetMessage.id)

      // Scroll the target into view once it re-renders in edit mode
      const id = targetMessage.id
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${id}"]`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
