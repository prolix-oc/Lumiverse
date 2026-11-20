import { afterEach, describe, expect, mock, test } from 'bun:test'
import { notifyImageDeleted, onImageDeleted } from '@/lib/deletion-events'

const del = mock<(...args: unknown[]) => Promise<any>>()
const get = mock<(...args: unknown[]) => Promise<any>>()

const post = mock((..._args: unknown[]) => Promise.resolve({
  total: 0,
  current: 0,
  generated: 0,
  skipped: 0,
  failed: 0,
}))

mock.module('./client', () => ({
  BASE_URL: '/custom/api',
  del,
  get,
  post,
  upload: mock(),
  uploadWithProgress: mock(),
}))

const { imagesApi } = await import('./images')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  post.mockClear()
  del.mockReset()
  get.mockReset()
})

describe('image deletion confirmation', () => {
  test('a completed HTTP response and duplicate event share one notification', async () => {
    const id = crypto.randomUUID()
    const listener = mock(() => {})
    const stop = onImageDeleted(listener)
    try {
      del.mockResolvedValue({ success: true, deleted: true, id, status: 'completed' })
      await imagesApi.delete(id)
      notifyImageDeleted(id)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(get).not.toHaveBeenCalled()
    } finally { stop() }
  })

  test('retained images stay visible and lost responses reconcile without another DELETE', async () => {
    const id = crypto.randomUUID()
    const listener = mock(() => {})
    const stop = onImageDeleted(listener)
    try {
      del.mockResolvedValue({ success: true, deleted: false, id, status: 'retained' })
      expect((await imagesApi.deleteIfUnused(id)).deleted).toBe(false)
      expect(listener).not.toHaveBeenCalled()
      del.mockRejectedValue(new Error('timeout'))
      get.mockResolvedValue({ id, deleted: true, status: 'completed' })
      expect((await imagesApi.deleteWallpaper(id)).status).toBe('completed')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(del).toHaveBeenCalledTimes(2)
      expect(get).toHaveBeenCalledWith(`/images/${id}/deletion-status`)
    } finally { stop() }
  })

  test('unconfirmed and unauthorized outcomes remain errors', async () => {
    const id = crypto.randomUUID()
    const listener = mock(() => {})
    const stop = onImageDeleted(listener)
    try {
      del.mockRejectedValue(new Error('timeout'))
      get.mockResolvedValue({ deleted: false, status: 'present' })
      await expect(imagesApi.delete(id)).rejects.toThrow('timeout')
      expect(listener).not.toHaveBeenCalled()
      get.mockClear()
      del.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }))
      await expect(imagesApi.delete(id)).rejects.toThrow('unauthorized')
      expect(get).not.toHaveBeenCalled()
    } finally { stop() }
  })
})

describe('imagesApi thumbnail rebuild', () => {
  test('renders durable local images directly and proxies remote covers', () => {
    expect(imagesApi.displayUrl('/api/v1/images/local-id')).toBe('/api/v1/images/local-id')
    expect(imagesApi.displayUrl('/custom/api/images/local-id')).toBe('/custom/api/images/local-id')
    expect(imagesApi.displayUrl('/user-media/preset-cover.webp')).toBe('/user-media/preset-cover.webp')
    expect(imagesApi.displayUrl('https://cdn.example.test/cover.webp')).toBe(
      '/custom/api/images/remote?url=https%3A%2F%2Fcdn.example.test%2Fcover.webp',
    )
  })

  test('offers a direct browser fallback only for remote HTTP cover URLs', () => {
    expect(imagesApi.directDisplayFallback('https://zip.example.test/u/preset.webp')).toBe(
      'https://zip.example.test/u/preset.webp',
    )
    expect(imagesApi.directDisplayFallback('/api/v1/images/local-id')).toBeNull()
    expect(imagesApi.directDisplayFallback('/user-media/preset-cover.webp')).toBeNull()
    expect(imagesApi.directDisplayFallback('data:image/png;base64,abc')).toBeNull()
    expect(imagesApi.directDisplayFallback('not a url')).toBeNull()
  })

  test('uses the shared API client for an ordinary rebuild', async () => {
    await imagesApi.rebuildThumbnails()

    expect(post).toHaveBeenCalledWith(
      '/images/rebuild-thumbnails',
      undefined,
      { timeout: 0 },
    )
  })

  test('uses the configured API base for a streaming rebuild', async () => {
    let requestedUrl = ''
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(
        'event: done\ndata: {"total":1,"current":1,"generated":1,"skipped":0,"failed":0}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    await expect(imagesApi.rebuildThumbnails({ onProgress: () => {} })).resolves.toMatchObject({
      total: 1,
      generated: 1,
    })
    expect(requestedUrl).toBe('/custom/api/images/rebuild-thumbnails')
  })
})
