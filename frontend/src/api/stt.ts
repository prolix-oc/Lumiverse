import { BASE_URL } from './client'

export const sttApi = {
  /**
   * Transcribe an audio blob via the backend OpenAI STT proxy.
   */
  async transcribe(
    audioBlob: Blob,
    options?: { language?: string; connectionId?: string; model?: string }
  ): Promise<{ text: string; language?: string }> {
    const form = new FormData()
    form.append('audio', audioBlob, 'recording.webm')
    if (options?.language) form.append('language', options.language)
    if (options?.connectionId) form.append('connectionId', options.connectionId)
    if (options?.model) form.append('model', options.model)

    const res = await fetch(`${BASE_URL}/stt/transcribe`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || `STT error ${res.status}`)
    }

    return res.json()
  },
}
