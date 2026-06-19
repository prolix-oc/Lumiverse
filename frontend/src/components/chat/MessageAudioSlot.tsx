import { clsx } from 'clsx'
import type { MessageAttachment } from '@/types/api'
import { audioApi } from '@/api/audio'
import MessageAudioPlayer from './MessageAudioPlayer'
import styles from './MessageAudioSlot.module.css'

interface MessageAudioSlotProps {
  /** The message's audio attachment, or null when none is present. */
  audio: MessageAttachment | null
  /** Message id for the player's fresh-marker consumption + stable key. */
  messageId: string
  /** Mirrors the bubble's user-or-character side so user-message audio
   *  (if it ever exists) aligns to the right like other user content. */
  isUser?: boolean
  /**
   * Optional delete callback forwarded to the player. When provided, the
   * player renders a tiny trash button at its trailing edge that fires
   * this callback on click. The bubble owns the actual deletion +
   * confirmation flow; the slot just plumbs the prop through.
   */
  onDelete?: () => void
}

/**
 * Always-mounted wrapper around the audio player whose height transitions
 * smoothly between 0 (no audio) and the player's natural height (audio
 * present). Uses CSS grid-template-rows: 0fr → 1fr so the collapsed state
 * contributes zero to the bubble's measured height — no wasted space when
 * there's no audio, no instant jump when audio attaches/detaches, and the
 * chat virtualizer sees gradual height deltas it can adjust to smoothly
 * rather than a single-frame remeasure that would shift scroll position.
 *
 * The component MUST stay mounted across the audio attach/detach lifecycle
 * for the transition to fire — that's the whole reason the bubble parent
 * renders it unconditionally (subject to !isEditing). When truly nothing
 * should reserve audio space (TTS disabled + no historical audio), the
 * bubble parent can omit it entirely and we render nothing.
 */
export default function MessageAudioSlot({
  audio,
  messageId,
  isUser,
  onDelete,
}: MessageAudioSlotProps) {
  const active = !!audio

  return (
    <div
      className={clsx(
        styles.slot,
        active && styles.slotActive,
        isUser && styles.slotUser,
      )}
    >
      <div className={styles.inner}>
        {audio && (
          <MessageAudioPlayer
            // Stable per-messageId key so a regen that replaces the audio
            // file doesn't trigger a remount — the player handles the src
            // swap internally. See MessageAttachments for the original
            // rationale.
            key={messageId}
            src={audioApi.url(audio.image_id)}
            title={audio.original_filename}
            isUser={isUser}
            messageId={messageId}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  )
}
