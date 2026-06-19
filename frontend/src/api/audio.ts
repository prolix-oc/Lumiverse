import { BASE_URL } from './client'
import type { Message } from '@/types/api'

export interface SavedTtsAudio {
  message: Message
  audio: {
    id: string
    mime_type: string
    original_filename: string
    size_bytes: number
    duration_ms: number | null
  }
  muxed_with_ffmpeg: boolean
}

export const audioApi = {
  /** URL to stream a stored audio file (immutable; safe to bind directly to <audio src>). */
  url(id: string): string {
    return `${BASE_URL}/audio/${id}`
  },

  /**
   * Save the per-segment audio buffers produced during a TTS playback as a
   * single message attachment. The server muxes them (ffmpeg when available,
   * naive MP3 frame concat otherwise) and writes a single audio_files row.
   * Replaces any prior audio attachment on the same message.
   */
  async saveForMessage(
    chatId: string,
    messageId: string,
    segments: { data: ArrayBuffer; mime: string }[],
    options?: { filename?: string; signal?: AbortSignal; swipeId?: number },
  ): Promise<SavedTtsAudio> {
    const form = new FormData()
    form.append('chatId', chatId)
    form.append('messageId', messageId)
    if (options?.filename) form.append('filename', options.filename)
    // Pass the swipeId captured at synth start so the backend can scope
    // the attachment correctly even if the user has swiped to a different
    // variant during synthesis. Omit when undefined — the backend falls
    // back to the message's current swipe_id in that case.
    if (typeof options?.swipeId === 'number') {
      form.append('swipeId', String(options.swipeId))
    }
    segments.forEach((seg, i) => {
      const blob = new Blob([seg.data], { type: seg.mime || 'audio/mpeg' })
      // The backend reads `segment` fields in insertion order. Filenames here
      // are diagnostic only — the server names files from the message id.
      form.append('segment', blob, `seg-${i.toString().padStart(4, '0')}`)
    })
    const res = await fetch(`${BASE_URL}/tts/save-message-audio`, {
      method: 'POST',
      credentials: 'include',
      signal: options?.signal,
      body: form,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    return res.json()
  },
}
