import { useEffect, useState } from 'react'

const WALLPAPER_VIDEO_CACHE = 'wallpaper-video-cache-v1'
const WALLPAPER_VIDEO_CACHE_LOOKUP_MS = 250
const WALLPAPER_VIDEO_CACHE_MAX_ENTRIES = 6
const WALLPAPER_VIDEO_RELEASE_DELAY_MS = 15000

type LiveEntry = {
  objectUrl: string
  refs: number
  releaseTimer: number | null
}

type ResolvedSource = {
  key: string | null
  src: string | null
  fromCache: boolean
}

const liveEntries = new Map<string, LiveEntry>()
const inflightPrimes = new Map<string, Promise<void>>()

function canUseCacheStorage(): boolean {
  return typeof window !== 'undefined' && 'caches' in window
}

function buildRequest(url: string): Request {
  return new Request(url, {
    credentials: 'include',
    mode: 'cors',
  })
}

function retainLiveEntry(url: string): { src: string; release: () => void } | null {
  const live = liveEntries.get(url)
  if (!live) return null
  if (live.releaseTimer !== null) {
    window.clearTimeout(live.releaseTimer)
    live.releaseTimer = null
  }
  live.refs += 1
  return {
    src: live.objectUrl,
    release: () => releaseLiveEntry(url),
  }
}

function releaseLiveEntry(url: string): void {
  const live = liveEntries.get(url)
  if (!live) return
  live.refs = Math.max(0, live.refs - 1)
  if (live.refs > 0 || live.releaseTimer !== null) return
  live.releaseTimer = window.setTimeout(() => {
    const current = liveEntries.get(url)
    if (!current || current.refs > 0) return
    URL.revokeObjectURL(current.objectUrl)
    liveEntries.delete(url)
  }, WALLPAPER_VIDEO_RELEASE_DELAY_MS)
}

function seedLiveEntry(url: string, objectUrl: string): void {
  if (liveEntries.has(url)) {
    URL.revokeObjectURL(objectUrl)
    return
  }

  liveEntries.set(url, {
    objectUrl,
    refs: 1,
    releaseTimer: null,
  })
  releaseLiveEntry(url)
}

async function trimWallpaperVideoCache(cache: Cache): Promise<void> {
  const keys = await cache.keys()
  const overflow = keys.length - WALLPAPER_VIDEO_CACHE_MAX_ENTRIES
  for (let index = 0; index < overflow; index += 1) {
    const oldest = keys[index]
    if (!oldest) break
    await cache.delete(oldest)
  }
}

async function loadCachedWallpaperVideo(url: string): Promise<{ src: string; release: () => void } | null> {
  if (!canUseCacheStorage() || !url) return null

  const live = retainLiveEntry(url)
  if (live) return live

  const cache = await caches.open(WALLPAPER_VIDEO_CACHE)
  const cached = await cache.match(buildRequest(url))
  if (!cached || !cached.ok) return null

  const blob = await cached.blob()
  if (!blob.size) return null

  const objectUrl = URL.createObjectURL(blob)
  const retained = retainLiveEntry(url)
  if (retained) {
    URL.revokeObjectURL(objectUrl)
    return retained
  }

  liveEntries.set(url, {
    objectUrl,
    refs: 1,
    releaseTimer: null,
  })

  return {
    src: objectUrl,
    release: () => releaseLiveEntry(url),
  }
}

function buildInitialResolvedSource(url: string | null): ResolvedSource {
  if (!url || !canUseCacheStorage()) {
    return {
      key: url,
      src: url,
      fromCache: false,
    }
  }

  return {
    key: url,
    src: null,
    fromCache: false,
  }
}

export function useWallpaperVideoSource(url: string | null): { src: string | null; fromCache: boolean } {
  const [resolved, setResolved] = useState<ResolvedSource>(() => buildInitialResolvedSource(url))
  const visible = resolved.key === url ? resolved : buildInitialResolvedSource(url)

  useEffect(() => {
    const initial = buildInitialResolvedSource(url)

    if (!url || !canUseCacheStorage()) {
      setResolved(initial)
      return
    }

    let cancelled = false
    let committed = false
    let release: (() => void) | null = null

    const live = retainLiveEntry(url)
    if (live) {
      release = live.release
      committed = true
      setResolved({
        key: url,
        src: live.src,
        fromCache: true,
      })
      return () => {
        cancelled = true
        if (release) release()
      }
    }

    setResolved(initial)

    const fallbackTimer = window.setTimeout(() => {
      if (cancelled || committed) return
      committed = true
      setResolved({
        key: url,
        src: url,
        fromCache: false,
      })
    }, WALLPAPER_VIDEO_CACHE_LOOKUP_MS)

    void loadCachedWallpaperVideo(url).then((resource) => {
      if (!resource) return
      if (cancelled) {
        resource.release()
        return
      }
      // If the direct-network path already started, don't switch sources mid-load.
      if (committed) {
        resource.release()
        return
      }
      committed = true
      window.clearTimeout(fallbackTimer)
      release = resource.release
      setResolved({
        key: url,
        src: resource.src,
        fromCache: true,
      })
    }).finally(() => {
      if (cancelled || committed) return
      committed = true
      window.clearTimeout(fallbackTimer)
      setResolved({
        key: url,
        src: url,
        fromCache: false,
      })
    })

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      if (release) release()
    }
  }, [url])

  return {
    src: visible.src,
    fromCache: visible.fromCache,
  }
}

export function primeWallpaperVideo(url: string): Promise<void> {
  if (!canUseCacheStorage() || !url) return Promise.resolve()

  const inflight = inflightPrimes.get(url)
  if (inflight) return inflight

  const task = (async () => {
    const request = buildRequest(url)
    const cache = await caches.open(WALLPAPER_VIDEO_CACHE)
    const existing = await cache.match(request)
    if (existing?.ok) return

    const response = await fetch(request.clone())
    if (!response.ok) return
    if (response.type !== 'basic' && response.type !== 'cors') return

    await cache.put(request, response.clone())
    const blob = await response.blob()
    if (blob.size) {
      seedLiveEntry(url, URL.createObjectURL(blob))
    }
    await trimWallpaperVideoCache(cache)
  })().finally(() => {
    inflightPrimes.delete(url)
  })

  inflightPrimes.set(url, task)
  return task
}
