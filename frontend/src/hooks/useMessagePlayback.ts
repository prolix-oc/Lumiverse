import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import {
  stop,
  getActiveMessageId,
  subscribeActiveMessage,
} from '@/lib/ttsAudio'
import {
  startMessageTtsPlayback,
  synthesizeSaveAndAutoPlay,
} from '@/lib/ttsMessagePlayback'
import { clearRegenerating, markRegenerating } from '@/lib/ttsPersistence'
import { messagesApi } from '@/api/chats'

/**
 * Subscribes to the shared TTS pipeline's "active message id" so a component
 * can flip between Play and Stop states without polling.
 */
export function useIsMessagePlaying(messageId: string): boolean {
  const activeId = useSyncExternalStore(
    subscribeActiveMessage,
    getActiveMessageId,
    () => null,
  )
  return activeId === messageId
}

export interface UseMessagePlaybackResult {
  /** True when TTS is configured enough to offer playback at all. */
  canPlay: boolean
  /** True when THIS message's audio is currently owning the TTS queue. */
  isPlaying: boolean
  /** True when this message already has a persisted audio attachment. */
  hasSavedAudio: boolean
  /**
   * True while a save-first regen is in flight (synth + save). The bubble's
   * TTS button uses this to render a "Cancel TTS generation" affordance so
   * the user isn't stuck waiting on a long regen they no longer want.
   */
  isGenerating: boolean
  /**
   * Primary action on the bubble's TTS button. Priority:
   *   • Generating → cancel the in-flight regen.
   *   • Playing    → stop the in-flight playback.
   *   • Saved      → open the regenerate-confirmation modal (saved audio is
   *                  played by the inline MessageAudioPlayer, not this
   *                  button).
   *   • Neither    → synthesize + play + persist in background.
   */
  toggle: () => Promise<void>
  /** True while the regen-confirmation modal should be visible. */
  regenModalOpen: boolean
  /** Confirm: closes the modal, starts a fresh synth that overwrites the saved audio. */
  confirmRegen: () => void
  /** Cancel: just closes the modal. */
  cancelRegen: () => void
  /**
   * Open the delete-confirmation modal. Wired to the player's trash
   * button via MessageAudioSlot. No-op when there's no saved audio to
   * delete (defensive — the player only renders the button when audio
   * exists, but guards against double-click races).
   */
  requestDelete: () => void
  /** True while the delete-confirmation modal should be visible. */
  deleteModalOpen: boolean
  /** Confirm: closes the modal, removes the audio attachment for this
   *  swipe via messagesApi.removeAttachment. The backend cleanup deletes
   *  the audio_files row + on-disk blob automatically. */
  confirmDelete: () => void
  /** Cancel: just closes the modal. */
  cancelDelete: () => void
}

/**
 * Per-message playback controller. Reuses the same singleton audio pipeline
 * as the auto-play hook so starting a manual playback cancels any in-flight
 * audio and vice versa. Routes through the shared multi-voice pipeline so
 * narration and per-character voices play gaplessly in segment order.
 *
 * Once a message has a persisted audio attachment, this hook no longer
 * triggers playback when its `toggle` is called — playback of the saved file
 * is owned by the inline `MessageAudioPlayer`. Instead, `toggle` opens a
 * confirmation modal so the user can choose to regenerate (and overwrite
 * the saved audio) without accidentally double-clicking the bubble button
 * and burning provider credits.
 */
export function useMessagePlayback(
  messageId: string,
  content: string,
  name: string,
  isUser: boolean,
): UseMessagePlaybackResult {
  const ttsEnabled = useStore((s) => s.voiceSettings.ttsEnabled)
  const connectionId = useStore((s) => s.voiceSettings.ttsConnectionId)
  const isPlaying = useIsMessagePlaying(messageId)
  // Watch the message in the store so we react when persistAfterPlayback or
  // a WS MESSAGE_EDITED event lands the audio attachment. Selector returns
  // a primitive so reference equality on `extra` doesn't cause needless
  // re-renders on unrelated edits.
  //
  // Audio is per-swipe: only count audio attachments matching the message's
  // current swipe_id (or legacy audio with no swipe_id, which applies to
  // all swipes). When the user swipes to a variant without its own
  // recording, hasSavedAudio flips to false → the TTS button reverts from
  // "Regenerate" to "Play with TTS" and the regen modal won't open.
  const hasSavedAudio = useStore((s) => {
    const msg = s.messages.find((m) => m.id === messageId)
    if (!msg) return false
    const attachments = Array.isArray((msg.extra as any)?.attachments)
      ? (msg.extra as any).attachments
      : []
    return attachments.some((a: any) =>
      a && a.type === 'audio' && (a.swipe_id === undefined || a.swipe_id === msg.swipe_id),
    )
  })
  // canPlay is permissive — a character or chat-level override can supply a
  // voice even when no global default is configured. The actual decision
  // lives in the resolver; the button just stays enabled when TTS is on.
  const canPlay = Boolean(ttsEnabled && connectionId)

  const [regenModalMessageId, setRegenModalMessageId] = useState<string | null>(null)
  const regenModalOpen = regenModalMessageId === messageId
  const [isGenerating, setIsGenerating] = useState(false)

  // AbortController for the active save-first regen. Held in a ref so the
  // toggle callback can fire abort() without listing the controller as a
  // dependency (which would re-create the callback on every regen tick).
  const regenAbortRef = useRef<AbortController | null>(null)

  // Best-effort cleanup if the consumer unmounts mid-regen (e.g. user
  // navigates away from the chat). Without this the synth would keep
  // running with nowhere to deliver the result.
  useEffect(() => {
    return () => {
      regenAbortRef.current?.abort()
      regenAbortRef.current = null
    }
  }, [])

  const cancelActiveRegen = useCallback(() => {
    const controller = regenAbortRef.current
    if (!controller) return
    controller.abort()
    regenAbortRef.current = null
    setIsGenerating(false)
  }, [])

  const toggle = useCallback(async () => {
    if (isGenerating) {
      cancelActiveRegen()
      return
    }
    if (isPlaying) {
      stop()
      return
    }
    if (hasSavedAudio) {
      setRegenModalMessageId(messageId)
      return
    }
    startMessageTtsPlayback({
      messageId,
      messageName: name,
      messageContent: content,
      messageIsUser: isUser,
    })
  }, [isGenerating, cancelActiveRegen, isPlaying, hasSavedAudio, content, messageId, name, isUser])

  const confirmRegen = useCallback(() => {
    const targetMessageId = regenModalMessageId
    setRegenModalMessageId(null)
    if (targetMessageId !== messageId) return

    // Stop any in-flight in-memory playback so the regen doesn't overlap
    // with whatever was playing.
    stop()

    // We deliberately do NOT strip the audio attachment from the store
    // during regen. Stripping unmounts the MessageAudioPlayer, which
    // collapses the message bubble's row height — and because the
    // messages list is virtualized, that height jump is translated into
    // a visible scroll shift. Instead we register the messageId in the
    // regenerating set; the still-mounted player observes the flag,
    // pauses its <audio>, and renders a regenerating overlay. When the
    // save endpoint returns, the backend has already replaced the audio
    // attachment on the message, so updateMessage swaps the player's
    // src in place (stable per-messageId key means no remount), the
    // regenerating flag is cleared, and the fresh-attachment marker
    // triggers auto-play of the new audio — all without the bubble's
    // row height changing for even a single frame.
    markRegenerating(messageId)

    // Cancel any prior regen still running (shouldn't normally happen since
    // the button switches to "Cancel" during generation, but defensive).
    regenAbortRef.current?.abort()
    const controller = new AbortController()
    regenAbortRef.current = controller
    setIsGenerating(true)

    void synthesizeSaveAndAutoPlay({
      messageId,
      messageName: name,
      messageContent: content,
      messageIsUser: isUser,
      signal: controller.signal,
    }).finally(() => {
      // Only clear if this controller is still the active one — a fast
      // cancel-then-restart race could have replaced it already, and we
      // don't want to flip isGenerating off mid-flight on the new run.
      if (regenAbortRef.current === controller) {
        regenAbortRef.current = null
        setIsGenerating(false)
      }
      clearRegenerating(messageId)
    })
  }, [content, messageId, name, isUser, regenModalMessageId])

  const cancelRegen = useCallback(() => {
    setRegenModalMessageId(null)
  }, [])

  // ── Delete flow ─────────────────────────────────────────────────────────
  // Requested from the player's tiny trash button via MessageAudioSlot.
  // Opens a confirmation modal; on confirm, removes the audio attachment
  // for this swipe via the existing messagesApi.removeAttachment endpoint.
  // The backend's removeMessageAttachment service handles freeing the
  // underlying audio_files row + on-disk blob, and emits MESSAGE_EDITED so
  // other clients re-render. Same-tab UI updates instantly from the
  // response.
  const [deleteModalMessageId, setDeleteModalMessageId] = useState<string | null>(null)
  const deleteModalOpen = deleteModalMessageId === messageId
  const addToast = useStore((s) => s.addToast)

  const requestDelete = useCallback(() => {
    if (!hasSavedAudio) return
    setDeleteModalMessageId(messageId)
  }, [hasSavedAudio, messageId])

  const cancelDelete = useCallback(() => {
    setDeleteModalMessageId(null)
  }, [])

  const confirmDelete = useCallback(() => {
    const targetMessageId = deleteModalMessageId
    setDeleteModalMessageId(null)
    if (targetMessageId !== messageId) return

    // Resolve the audio attachment for the current swipe FRESHLY (don't
    // capture in a closure dep) so a regen race or store update between
    // open-modal and confirm-click can't act on stale data.
    const state = useStore.getState()
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg) return

    const attachments = Array.isArray((msg.extra as any)?.attachments)
      ? (msg.extra as any).attachments
      : []
    const audio = attachments.find((a: any) =>
      a && a.type === 'audio' && (a.swipe_id === undefined || a.swipe_id === msg.swipe_id),
    )
    if (!audio?.image_id) return

    const chatId = msg.chat_id
    if (!chatId) return

    // Stop any in-flight playback of this audio before yanking it.
    stop()
    const el = document.querySelector(`audio[src*="${audio.image_id}"]`) as HTMLAudioElement | null
    if (el && !el.paused) el.pause()

    void (async () => {
      try {
        const updated = await messagesApi.removeAttachment(chatId, messageId, audio.image_id)
        if (updated) {
          useStore.getState().updateMessage(messageId, updated)
        }
      } catch (err: any) {
        addToast({
          type: 'error',
          title: 'Could not delete audio',
          message: err?.body?.error || err?.message || 'Unknown error',
        })
      }
    })()
  }, [messageId, addToast, deleteModalMessageId])

  return {
    canPlay,
    isPlaying,
    hasSavedAudio,
    isGenerating,
    toggle,
    regenModalOpen,
    confirmRegen,
    cancelRegen,
    requestDelete,
    deleteModalOpen,
    confirmDelete,
    cancelDelete,
  }
}
