import { afterEach, expect, mock, test } from 'bun:test'

mock.module('./client', () => ({ BASE_URL: '/api/v1' }))
const { ttsApi } = await import('./tts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

for (const method of ['synthesize', 'synthesizeStream'] as const) {
  test(`${method} forwards sampler overrides without losing zero/false settings`, async () => {
    let payload: any
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(`/api/v1/tts/synthesize${method === 'synthesizeStream' ? '/stream' : ''}`)
      payload = JSON.parse(String(init?.body))
      return new Response()
    }) as typeof fetch
    const parameters = { temperature: 0, normalize: false, normalize_loudness: false, repetition_penalty: 1.4, speed: 0.9 }
    await ttsApi[method]('fish-connection', 'Hello', { parameters, speed: 1.2 })
    expect(payload).toEqual({ connectionId: 'fish-connection', text: 'Hello', parameters: { ...parameters, speed: 1.2 } })
    expect(parameters.speed).toBe(0.9)
  })

  test(`${method} preserves a speed supplied with other parameters`, async () => {
    let payload: any
    globalThis.fetch = (async (_url, init) => {
      payload = JSON.parse(String(init?.body))
      return new Response()
    }) as typeof fetch
    await ttsApi[method]('fish-connection', 'Hello', { parameters: { speed: 0.8, condition_on_previous_chunks: false } })
    expect(payload.parameters).toEqual({ speed: 0.8, condition_on_previous_chunks: false })
    await ttsApi[method]('fish-connection', 'Hello')
    expect(payload).not.toHaveProperty('parameters')
  })
}
