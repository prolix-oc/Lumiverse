import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { executeSwipe } from './useSwipeAction'

/**
 * Global keyboard listener for ArrowLeft/ArrowRight swipe navigation.
 * - Default (no Shift): targets the last assistant message
 * - Shift held: targets the currently hovered assistant message
 */
export default function useSwipeKeyboard(): void {
  const hoveredMessageIdRef = useRef<string | null>(null)

  // Track hovered message via mouseover delegation
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-message-id]')
      if (target) {
        hoveredMessageIdRef.current = target.getAttribute('data-message-id')
      }
    }

    const handleMouseLeave = (e: MouseEvent) => {
      // Clear when leaving the chat area entirely
      if (!(e.relatedTarget as HTMLElement)?.closest?.('[data-message-id]')) {
        hoveredMessageIdRef.current = null
      }
    }

    document.addEventListener('mouseover', handleMouseOver)
    document.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      document.removeEventListener('mouseover', handleMouseOver)
      document.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

      // Block if any non-Shift modifier is held
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const state = useStore.getState()

      // Guard conditions
      if (!state.swipeGesturesEnabled) return
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

      const direction = e.key === 'ArrowLeft' ? 'left' : 'right'
      let targetMessage: typeof state.messages[number] | undefined

      if (e.shiftKey && hoveredMessageIdRef.current) {
        // Shift held: target hovered message
        targetMessage = state.messages.find(
          (m) => m.id === hoveredMessageIdRef.current && !m.is_user
        )
      } else if (!e.shiftKey) {
        // Default: target last assistant message
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (!state.messages[i].is_user) {
            targetMessage = state.messages[i]
            break
          }
        }
      }

      if (!targetMessage) return

      e.preventDefault()
      executeSwipe(targetMessage, state.activeChatId, direction)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
