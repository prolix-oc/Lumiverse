import { afterAll, beforeEach, expect, test } from 'bun:test'
import { acquireIOSMediaImage, canCacheIOSMediaImage, invalidateIOSMediaImage, setIOSMediaCacheAccount } from './ios-media-cache'

const originals = new Map(['window', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZkAAAAASUVORK5CYII='), char => char.charCodeAt(0))
const image = '/api/v1/images/avatar-1?size=lg'
let calls: { action: string; payload: any }[], fetches: string[], disk: Map<string, any>
let read: (payload: any) => Promise<any>
let network: (url: string, options: RequestInit) => Promise<Response>
let fetchOptions: RequestInit[]
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

beforeEach(() => {
  setIOSMediaCacheAccount(null)
  calls = []; fetches = []; fetchOptions = []; disk = new Map()
  read = async payload => disk.get(payload.url) ?? { scope: 'session-scope' }
  network = async () => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: new URL('https://server.example/'), __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, mediaCache: 1, async request(action: string, payload: any) {
      calls.push({ action, payload })
      if (action === 'mediaCache.read') return read(payload)
      if (action === 'mediaCache.write') { disk.set(payload.url, payload); return { stored: true } }
      return {}
    } },
  } })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url: string, options: RequestInit) => {
    fetches.push(url); fetchOptions.push(options); return network(url, options)
  } })
  setIOSMediaCacheAccount('alice')
})
afterAll(() => {
  setIOSMediaCacheAccount(null)
  originals.forEach((descriptor, key) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key))
})

test('a disk hit produces a blob with the original bytes without a network request', async () => {
  disk.set('https://server.example' + image, { scope: 'session-scope', data: btoa(String.fromCharCode(...bytes)), contentType: 'image/png' })
  const lease = acquireIOSMediaImage(image)!
  const blobURL = await lease.ready
  expect(blobURL.startsWith('blob:')).toBe(true)
  const blob = await originals.get('fetch')!.value(blobURL).then((response: Response) => response.arrayBuffer())
  expect(new Uint8Array(blob)).toEqual(bytes)
  expect(fetches).toEqual([])
  lease.release()
})

test('cold misses share one authenticated fetch and preserve thumbnail size in disk writes', async () => {
  const first = acquireIOSMediaImage(image)!, second = acquireIOSMediaImage(image)!
  expect(await first.ready).toBe(await second.ready)
  await flush()
  expect(fetches).toEqual(['https://server.example' + image])
  expect(fetchOptions[0]).toMatchObject({ credentials: 'same-origin', redirect: 'error' })
  expect(fetchOptions[0].cache).toBeUndefined()
  const write = calls.find(call => call.action === 'mediaCache.write')!
  expect(write.payload).toMatchObject({ accountId: 'alice', scope: 'session-scope', url: 'https://server.example' + image, contentType: 'image/png' })
  first.release(); second.release()
})

test('old wrappers, other origins, mutable avatar resolvers and video requests retain the browser path', () => {
  for (const src of ['https://other.example/api/v1/images/avatar-1?size=lg', '/api/v1/characters/character-1/avatar?size=lg', '/api/v1/images/remote?url=x', '/api/v1/images/avatar-1?codec=h264', '/api/v1/images/avatar-1?size=lg&size=sm', '/api/v1/images/avatar-1#x']) {
    expect(acquireIOSMediaImage(src)).toBeNull()
  }
  delete (window as any).__LUMIVERSE_IOS_NATIVE__.mediaCache
  expect(acquireIOSMediaImage(image)).toBeNull()
  expect(calls).toEqual([])
})

test('logout discards a late cache result and another account obtains its own lookup', async () => {
  let complete!: (value: any) => void
  read = () => new Promise(resolve => { complete = resolve })
  const lease = acquireIOSMediaImage(image)!
  setIOSMediaCacheAccount(null)
  complete({ scope: 'old-session', data: btoa(String.fromCharCode(...bytes)), contentType: 'image/png' })
  expect(await lease.ready).toBe('https://server.example' + image)
  await flush()
  expect(fetches).toEqual([])
  expect(canCacheIOSMediaImage(image)).toBe(false)
  setIOSMediaCacheAccount('bob')
  read = async () => ({ scope: 'bob-session', data: btoa(String.fromCharCode(...bytes)), contentType: 'image/png' })
  const bob = acquireIOSMediaImage(image)!
  expect((await bob.ready).startsWith('blob:')).toBe(true)
  expect(calls.filter(call => call.action === 'mediaCache.read').map(call => call.payload.accountId)).toEqual(['alice', 'bob'])
  bob.release(); lease.release()
})

test('native errors fall back promptly and no-store responses are never persisted', async () => {
  read = async () => { throw new Error('Disk unavailable') }
  let lease = acquireIOSMediaImage(image)!
  expect(await lease.ready).toBe('https://server.example' + image)
  expect(fetches).toEqual([]); lease.release()
  read = async () => ({ scope: 'session-scope' })
  network = async () => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store, immutable' } })
  lease = acquireIOSMediaImage(image)!
  expect((await lease.ready).startsWith('blob:')).toBe(true)
  expect(calls.some(call => call.action === 'mediaCache.write')).toBe(false)
  lease.release()
})

test('non-raster and oversized responses fall back without storing bytes', async () => {
  network = async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })
  let lease = acquireIOSMediaImage(image)!
  expect(await lease.ready).toBe('https://server.example' + image); lease.release()
  network = async () => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(3 * 1024 * 1024) } })
  lease = acquireIOSMediaImage(image)!
  expect(await lease.ready).toBe('https://server.example' + image); lease.release()
  expect(calls.some(call => call.action === 'mediaCache.write')).toBe(false)
})

test('requests are bounded to four concurrent transfers and release cancels queued work', async () => {
  let running = 0, peak = 0
  const completions: (() => void)[] = []
  network = async (_url, options) => {
    running++; peak = Math.max(peak, running)
    await new Promise<void>(resolve => { completions.push(resolve); options.signal!.addEventListener('abort', () => resolve(), { once: true }) })
    running--
    if (options.signal!.aborted) throw new Error('Aborted')
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
  }
  const leases = Array.from({ length: 10 }, (_, index) => acquireIOSMediaImage(`/api/v1/images/image-${index}?size=lg`)!)
  await flush()
  expect(peak).toBe(4)
  for (const lease of leases) lease.release()
  for (const complete of completions) complete()
  await Promise.all(leases.map(lease => lease.ready)); await flush()
  expect(fetches).toHaveLength(4)
})

test('deletion invalidates every tier natively and removes resident blobs', async () => {
  const lease = acquireIOSMediaImage(image)!
  await lease.ready; await flush()
  invalidateIOSMediaImage(image)
  expect(calls.some(call => call.action === 'mediaCache.remove' && call.payload.url.endsWith('?size=lg'))).toBe(true)
  const again = acquireIOSMediaImage(image)!
  await again.ready
  expect(calls.filter(call => call.action === 'mediaCache.read')).toHaveLength(2)
  again.release(); lease.release()
})

test('deleting an image before the first lookup still invalidates its persistent entry', () => {
  invalidateIOSMediaImage(image)
  expect(calls).toEqual([{ action: 'mediaCache.remove', payload: { accountId: 'alice', url: 'https://server.example' + image } }])
})
