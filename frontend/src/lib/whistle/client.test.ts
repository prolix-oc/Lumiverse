import { afterEach, describe, expect, test } from 'bun:test'
import { WhistleClient } from './client'
import type { WhistleRequest, WhistleResponse } from './config'

class FakeWorker {
  onmessage: ((event: { data: WhistleResponse }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: WhistleRequest[] = []
  terminated = false
  postMessage(message: WhistleRequest) { this.messages.push(message) }
  terminate() { this.terminated = true }
  reply(message: WhistleResponse) { this.onmessage?.({ data: message }) }
}

const clients: WhistleClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose() })
function setup() {
  const workers: FakeWorker[] = []
  const client = new WhistleClient(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  clients.push(client)
  return { client, workers }
}

describe('Whistle worker lifecycle', () => {
  test('shares preparation and keeps the warm engine for subsequent dictation', async () => {
    const { client, workers } = setup()
    const first = client.prepare()
    const second = client.prepare()
    expect(first).toBe(second)
    expect(workers).toHaveLength(1)
    workers[0].reply({ type: 'progress', progress: 0.5 })
    expect(client.getState().progress).toBe(0.5)
    workers[0].reply({ type: 'ready', id: workers[0].messages[0].id })
    await first
    expect(client.getState().phase).toBe('ready')
    await client.prepare()
    expect(workers[0].messages).toHaveLength(1)
    const transcription = client.transcribe(new Float32Array(1600), 'en')
    await Promise.resolve()
    const request = workers[0].messages.at(-1)!
    workers[0].reply({ type: 'result', id: request.id, result: { text: 'hello', language: 'en', words: [] } })
    expect((await transcription).text).toBe('hello')
  })

  test('ignores late transcription after cancellation and accepts the next request', async () => {
    const { client, workers } = setup()
    const preparing = client.prepare()
    workers[0].reply({ type: 'ready', id: workers[0].messages[0].id })
    await preparing
    const abort = new AbortController()
    const cancelled = client.transcribe(new Float32Array(1600), undefined, abort.signal)
    await Promise.resolve()
    const oldId = workers[0].messages.at(-1)!.id
    abort.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    workers[0].reply({ type: 'result', id: oldId, result: { text: 'stale', language: 'en', words: [] } })
    const next = client.transcribe(new Float32Array(1600))
    await Promise.resolve()
    workers[0].reply({ type: 'result', id: workers[0].messages.at(-1)!.id, result: { text: 'new', language: 'en', words: [] } })
    expect((await next).text).toBe('new')
  })

  test('settles preparation on a crash and retries with a new worker', async () => {
    const { client, workers } = setup()
    const preparing = client.prepare()
    workers[0].onerror?.({ message: 'crashed' })
    await expect(preparing).rejects.toThrow('crashed')
    expect(workers[0].terminated).toBe(true)
    expect(client.getState().phase).toBe('error')
    const retry = client.prepare()
    workers[1].reply({ type: 'ready', id: workers[1].messages[0].id })
    await retry
    expect(client.getState().phase).toBe('ready')
  })
})
