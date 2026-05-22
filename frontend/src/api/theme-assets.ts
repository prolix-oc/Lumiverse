import { get, post, patch, del, upload, uploadWithProgress, getBlob, BASE_URL } from './client'
import type { ThemeAsset } from '@/types/api'

export interface UploadThemeAssetInput {
  bundleId: string
  slug?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface UpdateThemeAssetInput {
  slug?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export const themeAssetsApi = {
  list(bundleId: string) {
    return get<ThemeAsset[]>('/theme-assets', { bundle_id: bundleId })
  },

  upload(file: File, input: UploadThemeAssetInput, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('asset', file)
    form.append('bundle_id', input.bundleId)
    if (input.slug) form.append('slug', input.slug)
    if (input.tags?.length) form.append('tags', JSON.stringify(input.tags))
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      form.append('metadata', JSON.stringify(input.metadata))
    }
    if (onProgress) return uploadWithProgress<ThemeAsset>('/theme-assets', form, onProgress)
    return upload<ThemeAsset>('/theme-assets', form)
  },

  update(id: string, input: UpdateThemeAssetInput) {
    return patch<ThemeAsset>(`/theme-assets/${id}`, input)
  },

  optimizeWebp(id: string) {
    return post<ThemeAsset>(`/theme-assets/${id}/optimize-webp`)
  },

  delete(id: string) {
    return del<void>(`/theme-assets/${id}`)
  },

  get(id: string) {
    return get<ThemeAsset>(`/theme-assets/${id}`)
  },

  getBlob(id: string) {
    return getBlob(`/theme-assets/${id}/content`)
  },

  bundleUrl(bundleId: string, slug: string) {
    const encodedSlug = slug.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `${BASE_URL}/theme-assets/bundles/${encodeURIComponent(bundleId)}/${encodedSlug}`
  },

  contentUrl(id: string) {
    return `${BASE_URL}/theme-assets/${encodeURIComponent(id)}/content`
  },
}
