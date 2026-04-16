import { BASE_URL } from './client'

export const ttsApi = {
  /**
   * Synthesize speech. Returns raw Response for ArrayBuffer/stream consumption.
   * Caller must check response.ok and handle errors.
   */
  async synthesize(
    connectionId: string,
    text: string,
    options?: { voice?: string; model?: string; speed?: number; outputFormat?: string }
  ): Promise<Response> {
    return fetch(`${BASE_URL}/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        connectionId,
        text,
        voice: options?.voice,
        model: options?.model,
        parameters: options?.speed != null ? { speed: options.speed } : undefined,
        outputFormat: options?.outputFormat,
      }),
    })
  },

  /**
   * Synthesize speech with streaming. Returns raw Response with ReadableStream body.
   */
  async synthesizeStream(
    connectionId: string,
    text: string,
    options?: { voice?: string; model?: string; speed?: number }
  ): Promise<Response> {
    return fetch(`${BASE_URL}/tts/synthesize/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        connectionId,
        text,
        voice: options?.voice,
        model: options?.model,
        parameters: options?.speed != null ? { speed: options.speed } : undefined,
      }),
    })
  },
}
