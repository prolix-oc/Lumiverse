import { get, del, upload, uploadWithProgress, BASE_URL } from './client'
import type { Image } from '@/types/api'

export type ImageSize = 'sm' | 'lg'

export interface ThumbnailRebuildProgress {
  total: number
  current: number
  generated: number
  skipped: number
  failed: number
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

  delete(id: string) {
    return del<void>(`/images/${id}`)
  },

  deleteIfUnused(id: string) {
    return del<{ success: boolean; deleted: boolean }>(`/images/${id}?unused=true`)
  },

  /** Full-size original */
  url(id: string) {
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

  rebuildThumbnails(options?: {
    onProgress?: (p: ThumbnailRebuildProgress) => void
  }): Promise<ThumbnailRebuildProgress> {
    if (options?.onProgress) {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(`/api/v1/images/rebuild-thumbnails`, {
            method: 'POST',
            headers: { Accept: 'text/event-stream' },
            credentials: 'include',
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Rebuild failed' }))
            reject(new Error(err.error || `HTTP ${res.status}`))
            return
          }
          const reader = res.body?.getReader()
          if (!reader) { reject(new Error('No response body')); return }

          const decoder = new TextDecoder()
          let buffer = ''
          let finalResult: any = null

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            let eventType = ''
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim()
              } else if (line.startsWith('data: ')) {
                const data = JSON.parse(line.slice(6))
                if (eventType === 'progress') options.onProgress!(data)
                else if (eventType === 'done') finalResult = data
                else if (eventType === 'error') { reject(new Error(data.error)); return }
              }
            }
          }
          resolve(finalResult || { total: 0, current: 0, generated: 0, skipped: 0, failed: 0 })
        } catch (err) {
          reject(err)
        }
      })
    }

    return fetch(`/api/v1/images/rebuild-thumbnails`, {
      method: 'POST',
      credentials: 'include',
    }).then((r) => r.json())
  },
}
