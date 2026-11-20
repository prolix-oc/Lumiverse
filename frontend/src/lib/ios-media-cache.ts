import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'
import { isImageDeleted, onImageDeleted } from './deletion-events'

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_RESIDENT_BYTES = 12 * 1024 * 1024
const MAX_RESIDENT_IMAGES = 32
const MAX_REQUESTS = 48
const CONCURRENCY = 4
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
type NativeRead = { scope?: string; data?: string; contentType?: string }
export interface IOSMediaLease { ready: Promise<string>; release(): void }
interface ImageRequest {
  src: string
  imageId: string
  account: string
  generation: number
  refs: number
  bytes: number
  objectURL?: string
  controller: AbortController
  ready: Promise<string>
  resolve: (url: string) => void
  settled: boolean
}

let accountId: string | null = null
let generation = 0
let active = 0
let nativeScope: string | null = null
let queue: ImageRequest[] = []
const requests = new Map<string, ImageRequest>()

export function supportsIOSMediaCache(): boolean {
  return hasIOSNativeBridge()
    && (window as Window & { __LUMIVERSE_IOS_NATIVE__?: { mediaCache?: number } }).__LUMIVERSE_IOS_NATIVE__?.mediaCache === 1
}

function destination(src: string): { url: string; imageId: string } | null {
  try {
    const url = new URL(src, window.location.href)
    const match = url.pathname.match(/^\/api\/v1\/images\/([A-Za-z0-9_-]{1,128})$/)
    const query = [...url.searchParams]
    if (url.origin !== window.location.origin || url.username || url.password || url.hash || !match
      || (query.length !== 0 && (query.length !== 1 || query[0][0] !== 'size' || !['sm', 'lg'].includes(query[0][1])))) return null
    return { url: url.href, imageId: match[1] }
  } catch { return null }
}

export function canCacheIOSMediaImage(src: string): boolean {
  return Boolean(accountId && supportsIOSMediaCache() && destination(src))
}

function discard(request: ImageRequest) {
  request.controller.abort()
  if (request.objectURL) { URL.revokeObjectURL(request.objectURL); request.objectURL = undefined }
  if (requests.get(request.src) === request) requests.delete(request.src)
  if (!request.settled) { request.settled = true; request.resolve(request.src) }
}

function trim() {
  let bytes = [...requests.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  let images = [...requests.values()].filter(entry => entry.objectURL).length
  for (const entry of requests.values()) {
    if (bytes <= MAX_RESIDENT_BYTES && images <= MAX_RESIDENT_IMAGES) break
    if (entry.refs || !entry.settled || !entry.objectURL) continue
    bytes -= entry.bytes; images -= 1; discard(entry)
  }
}

function current(entry: ImageRequest): boolean {
  return !entry.controller.signal.aborted && entry.generation === generation && entry.account === accountId && !isImageDeleted(entry.imageId)
}

async function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native media cache timed out')), ms) })])
  } finally { clearTimeout(timer!) }
}

function fromBase64(data: string): Uint8Array {
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Oversized cached image')
  return Uint8Array.from(atob(data), char => char.charCodeAt(0))
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16_384) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16_384)))
  return btoa(chunks.join(''))
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing image body')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_IMAGE_BYTES) throw new Error('Image exceeds native cache limit')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function load(entry: ImageRequest): Promise<string> {
  // Only this short cache lookup precedes the normal authenticated transfer.
  const cached = await timed(iosNativeRequest<NativeRead>('mediaCache.read', { accountId: entry.account, url: entry.src }), 250)
  if (!current(entry) || !cached?.scope) return entry.src
  nativeScope = cached.scope
  let bytes: Uint8Array, type: string
  if (cached.data && cached.contentType && RASTER_TYPES.has(cached.contentType)) {
    bytes = fromBase64(cached.data); type = cached.contentType
  } else {
    const timeout = setTimeout(() => entry.controller.abort(), 15_000)
    try {
      // WebKit owns authentication and transport. Native never receives a server URL to fetch.
      const response = await fetch(entry.src, { credentials: 'same-origin', redirect: 'error', signal: entry.controller.signal })
      type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
      if (!response.ok || !RASTER_TYPES.has(type) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel(); return entry.src
      }
      bytes = await readCapped(response)
      if (!current(entry) || !bytes.length) return entry.src
      const policy = response.headers.get('cache-control') ?? ''
      if (/\bimmutable\b/i.test(policy) && !/\b(?:no-store|no-cache)\b/i.test(policy)) {
        // Saving does not delay presentation. Cookie-derived scope is checked again natively.
        void timed(iosNativeRequest('mediaCache.write', {
          accountId: entry.account, scope: cached.scope, url: entry.src, data: toBase64(bytes), contentType: type,
        }), 1500).catch(() => {})
      }
    } finally { clearTimeout(timeout) }
  }
  if (!current(entry) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return entry.src
  // Active images count against the resident budget too; evict idle blobs first.
  let resident = [...requests.values()].reduce((sum, request) => sum + request.bytes, 0)
  for (const idle of requests.values()) {
    if (resident + bytes.length <= MAX_RESIDENT_BYTES) break
    if (idle.refs || !idle.objectURL) continue
    resident -= idle.bytes; discard(idle)
  }
  if (resident + bytes.length > MAX_RESIDENT_BYTES) return entry.src
  entry.bytes = bytes.length
  entry.objectURL = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  return entry.objectURL
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const entry = queue.shift()!
    if (!current(entry)) { discard(entry); continue }
    active++
    void load(entry).catch(() => entry.src).then(url => {
      if (!entry.settled) { entry.settled = true; entry.resolve(url) }
      if (!entry.objectURL && requests.get(entry.src) === entry) requests.delete(entry.src)
    }).finally(() => { active--; trim(); pump() })
  }
}

/** Null means the caller should use its unchanged <img src> path. */
export function acquireIOSMediaImage(src: string): IOSMediaLease | null {
  if (!accountId || !supportsIOSMediaCache()) return null
  const target = destination(src)
  if (!target || isImageDeleted(target.imageId)) return null
  let entry = requests.get(target.url)
  if (!entry) {
    if (requests.size >= MAX_REQUESTS) { trim(); if (requests.size >= MAX_REQUESTS) return null }
    let resolve!: (value: string) => void
    const ready = new Promise<string>(done => { resolve = done })
    entry = { src: target.url, imageId: target.imageId, account: accountId, generation, refs: 0, bytes: 0, controller: new AbortController(), ready, resolve, settled: false }
    requests.set(target.url, entry); queue.push(entry)
  }
  requests.delete(entry.src); requests.set(entry.src, entry)
  entry.refs++
  pump()
  let released = false
  return { ready: entry.ready, release() {
    if (released) return; released = true
    entry!.refs = Math.max(0, entry!.refs - 1)
    if (!entry!.refs && !entry!.settled) discard(entry!)
    trim()
  } }
}

/** Called before authenticated views render and synchronously on logout/account reset. */
export function setIOSMediaCacheAccount(account: string | null): void {
  if (account === accountId) return
  if (accountId && supportsIOSMediaCache()) {
    void iosNativeRequest('mediaCache.clear', { accountId, ...(nativeScope ? { scope: nativeScope } : {}) }).catch(() => {})
  }
  generation++
  for (const request of requests.values()) discard(request)
  requests.clear(); queue = []; nativeScope = null; accountId = account
}

export function invalidateIOSMediaImage(src: string): void {
  const target = destination(src)
  if (!target) return
  for (const entry of requests.values()) if (entry.imageId === target.imageId) discard(entry)
  if (accountId && supportsIOSMediaCache()) {
    void iosNativeRequest('mediaCache.remove', { accountId, ...(nativeScope ? { scope: nativeScope } : {}), url: target.url }).catch(() => {})
  }
}

onImageDeleted(imageId => {
  if (supportsIOSMediaCache()) invalidateIOSMediaImage(`/api/v1/images/${encodeURIComponent(imageId)}`)
})
