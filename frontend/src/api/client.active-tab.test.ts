import { afterEach, expect, mock, test } from 'bun:test'

let controller = new AbortController()
mock.module('@/lib/active-tab', () => ({ activeTab: {
  get signal() { return controller.signal },
  assertActive() { controller.signal.throwIfAborted() },
} }))
const api = await import('./client')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; controller = new AbortController() })

test('losing ownership aborts an outstanding API request', async () => {
  let signal!: AbortSignal
  globalThis.fetch = mock((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    signal = options.signal!
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as unknown as typeof fetch
  const pending = api.post('/test', {}).catch(error => error)
  const reason = new Error('Tab inactive')
  controller.abort(reason)
  expect(signal.aborted).toBe(true)
  expect(await pending).toBe(reason)
})

test('inactive documents cannot issue new mutations', async () => {
  const fetchMock = mock(() => Promise.resolve(new Response('{}')))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  controller.abort(new Error('Tab inactive'))
  for (const operation of [() => api.post('/test'), () => api.put('/test'),
    () => api.patch('/test'), () => api.del('/test'), () => api.upload('/test', new FormData()),
    () => api.uploadRaw('/test', new Blob()), () => api.uploadWithProgress('/test', new FormData())]) {
    await expect(operation()).rejects.toThrow('Tab inactive')
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
