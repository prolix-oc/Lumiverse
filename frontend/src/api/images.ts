import { get, del, post, upload, uploadWithProgress, BASE_URL } from './client'
import type { Image } from '@/types/api'
import { isImageDeleted, notifyImageDeleted } from '@/lib/deletion-events'

export interface ImageDeletionResult {
  success: boolean
  deleted: boolean
  id: string
  status: 'completed' | 'retained'
}

async function deleteAndConfirm(id: string, path: string): Promise<ImageDeletionResult> {
  try {
    const result = await del<ImageDeletionResult>(path)
    if (result?.deleted && result.status === 'completed') notifyImageDeleted(id)
    else if (!result || result.deleted !== false || result.status !== 'retained') throw new Error('Image deletion could not be confirmed')
    return result
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403 || error?.name === 'InactiveTabError') throw error
    // A timeout can follow a committed deletion. Reconcile without replaying it.
    try {
      const status = isImageDeleted(id) ? { deleted: true } : await get<{ deleted: boolean }>(`/images/${encodeURIComponent(id)}/deletion-status`)
      if (status.deleted) {
        notifyImageDeleted(id)
        return { success: true, deleted: true, id, status: 'completed' }
      }
    } catch { /* Preserve the original failure while the outcome is unconfirmed. */ }
    throw error
  }
}

export type ImageSize = 'sm' | 'lg'

export interface ImageListResult {
  data: Image[]
  total: number
}

export interface ThumbnailRebuildProgress {
  total: number
  current: number
  generated: number
  skipped: number
  failed: number
}

interface WallpaperUploadOptions {
  onProgress?: (percent: number) => void
  uploadId?: string
}

interface ImageUrlOptions {
  codec?: 'h264' | 'hevc'
}

function joinApiPath(path: string): string {
  return `${BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function isDirectImageUrl(value: string): boolean {
  const apiBase = BASE_URL.replace(/\/+$/, '')
  return (value.startsWith('/') && !value.startsWith('//'))
    || value.startsWith(`${apiBase}/images/`)
    || value.startsWith('/api/v1/images/')
}

export const imagesApi = {
  get(id: string) {
    return get<Image>(`/images/${id}`)
  },

  upload(file: File, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('image', file)
    if (onProgress) {
      return uploadWithProgress<Image>('/images', form, onProgress)
    }
    return upload<Image>('/images', form)
  },

  uploadWallpaper(file: File, kind: 'image' | 'video', options?: WallpaperUploadOptions) {
    const form = new FormData()
    form.append('image', file)
    const params = new URLSearchParams()
    if (kind === 'video') {
      params.set('strip_audio', '1')
      params.set('video_codec', 'h264')
    }
    if (options?.uploadId) {
      params.set('upload_id', options.uploadId)
    }
    const path = `/images/wallpapers${params.size > 0 ? `?${params.toString()}` : ''}`
    if (options?.onProgress) {
      return uploadWithProgress<Image>(path, form, options.onProgress)
    }
    return upload<Image>(path, form, kind === 'video' ? { timeout: 0 } : undefined)
  },

  listWallpapers(params?: { limit?: number; offset?: number }) {
    return get<ImageListResult>('/images/wallpapers', params)
  },

  deleteWallpaper(id: string) {
    return deleteAndConfirm(id, `/images/wallpapers/${encodeURIComponent(id)}`)
  },

  delete(id: string) {
    return deleteAndConfirm(id, `/images/${encodeURIComponent(id)}`)
  },

  deleteIfUnused(id: string) {
    return deleteAndConfirm(id, `/images/${encodeURIComponent(id)}?unused=true`)
  },

  /** Full-size original */
  url(id: string, options?: ImageUrlOptions) {
    if (options?.codec) {
      return `${BASE_URL}/images/${id}?codec=${encodeURIComponent(options.codec)}`
    }
    return `${BASE_URL}/images/${id}`
  },

  /** Small tier (~300px) — cards, message avatars, small UI */
  smallUrl(id: string) {
    return `${BASE_URL}/images/${id}?size=sm`
  },

  /** Large tier (~700px) — portrait panel, editor preview */
  largeUrl(id: string) {
    return `${BASE_URL}/images/${id}?size=lg`
  },

  /** Same-origin proxy for third-party raster images used in rich HTML. */
  remoteUrl(url: string) {
    return `${joinApiPath('/images/remote')}?url=${encodeURIComponent(url)}`
  },

  /** Render a durable local image directly; proxy only third-party URLs. */
  displayUrl(url: string) {
    const value = url.trim()
    if (isDirectImageUrl(value)) return value
    return `${joinApiPath('/images/remote')}?url=${encodeURIComponent(value)}`
  },

  /**
   * Browser-side fallback for split-horizon/LAN hosts rejected by the SSRF-safe
   * proxy. The caller should try this only after displayUrl() fails.
   */
  directDisplayFallback(url: string) {
    const value = url.trim()
    if (!value || isDirectImageUrl(value)) return null
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
    } catch {
      return null
    }
  },

  rebuildThumbnails(options?: {
    onProgress?: (p: ThumbnailRebuildProgress) => void
  }): Promise<ThumbnailRebuildProgress> {
    if (options?.onProgress) {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(joinApiPath('/images/rebuild-thumbnails'), {
            method: 'POST',
            headers: { Accept: 'text/event-stream' },
            credentials: 'include',
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Rebuild failed' }))
            reject(new Error(err.error || `HTTP ${res.status}`))
            return
          }
          if (!res.headers.get('content-type')?.includes('text/event-stream')) {
            const contentType = res.headers.get('content-type') || 'unknown content type'
            reject(new Error(`Rebuild endpoint returned ${contentType} instead of an event stream`))
            return
          }
          const reader = res.body?.getReader()
          if (!reader) { reject(new Error('No response body')); return }

          const decoder = new TextDecoder()
          let buffer = ''
          let finalResult: any = null
          let eventType = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim()
              } else if (line.startsWith('data: ')) {
                const data = JSON.parse(line.slice(6))
                if (eventType === 'progress') options.onProgress!(data)
                else if (eventType === 'done') finalResult = data
                else if (eventType === 'error') { reject(new Error(data.error)); return }
                eventType = ''
              }
            }
          }
          resolve(finalResult || { total: 0, current: 0, generated: 0, skipped: 0, failed: 0 })
        } catch (err) {
          reject(err)
        }
      })
    }

    return post<ThumbnailRebuildProgress>('/images/rebuild-thumbnails', undefined, { timeout: 0 })
  },
}
