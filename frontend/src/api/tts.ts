import { BASE_URL } from './client'

export interface TtsSynthesizeOptions {
  voice?: string
  model?: string
  speed?: number
  parameters?: Record<string, unknown>
  outputFormat?: string
  signal?: AbortSignal
}

function requestParameters(options?: TtsSynthesizeOptions): Record<string, unknown> | undefined {
  const parameters = { ...options?.parameters }
  if (options?.speed != null) parameters.speed = options.speed
  return Object.keys(parameters).length ? parameters : undefined
}

export const ttsApi = {
  /**
   * Synthesize speech. Returns raw Response for ArrayBuffer/stream consumption.
   * Caller must check response.ok and handle errors.
   */
  async synthesize(
    connectionId: string,
    text: string,
    options?: TtsSynthesizeOptions
  ): Promise<Response> {
    return fetch(`${BASE_URL}/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: options?.signal,
      body: JSON.stringify({
        connectionId,
        text,
        voice: options?.voice,
        model: options?.model,
        parameters: requestParameters(options),
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
    options?: TtsSynthesizeOptions
  ): Promise<Response> {
    return fetch(`${BASE_URL}/tts/synthesize/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      credentials: 'include',
      signal: options?.signal,
      body: JSON.stringify({
        connectionId,
        text,
        voice: options?.voice,
        model: options?.model,
        parameters: requestParameters(options),
        outputFormat: options?.outputFormat,
      }),
    })
  },
}
