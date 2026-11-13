import { beforeEach, describe, expect, mock, test } from 'bun:test'

const post = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('./client', () => ({
  del: mock(),
  get: mock(),
  post,
  put: mock(),
  upload: mock(),
}))

const { ttsConnectionsApi } = await import('./tts-connections')

describe('ttsConnectionsApi voice discovery', () => {
  beforeEach(() => {
    post.mockClear()
  })

  test('forwards request options so superseded voice discovery can be cancelled', async () => {
    const input = {
      provider: 'openvox_tts',
      api_url: 'http://127.0.0.1:8000/v1',
      model: 'kokoro',
    }
    const signal = new AbortController().signal
    const response = { provider: 'openvox_tts', voices: [] }
    post.mockResolvedValueOnce(response)

    await expect(ttsConnectionsApi.previewVoices(input, { signal })).resolves.toEqual(response)
    expect(post).toHaveBeenCalledWith('/tts-connections/voices/preview', input, { signal })
  })

  test('preserves the existing one-argument call shape for other TTS providers', async () => {
    const input = { provider: 'elevenlabs' }
    const response = { provider: 'elevenlabs', voices: [] }
    post.mockResolvedValueOnce(response)

    await expect(ttsConnectionsApi.previewVoices(input)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledWith('/tts-connections/voices/preview', input, undefined)
  })

  test('browses the library without putting credentials in the URL and forwards cancellation', async () => {
    const input = { provider: 'elevenlabs', api_key: 'draft-key', page: 1, search: 'calm' }
    const signal = new AbortController().signal
    await ttsConnectionsApi.voiceLibrary(input, { signal })
    expect(post).toHaveBeenCalledWith('/tts-connections/voices/library', input, { signal })
  })
})
