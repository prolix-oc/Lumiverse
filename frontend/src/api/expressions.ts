import { get, put, post, del, upload, BASE_URL } from './client'
import type { ExpressionConfig } from '@/types/expressions'

const basePath = (characterId: string) => `/characters/${characterId}/expressions`

export const expressionsApi = {
  get(characterId: string): Promise<ExpressionConfig> {
    return get<ExpressionConfig>(basePath(characterId))
  },

  put(characterId: string, config: ExpressionConfig): Promise<ExpressionConfig> {
    return put<ExpressionConfig>(basePath(characterId), config)
  },

  uploadZip(characterId: string, file: File): Promise<ExpressionConfig> {
    const formData = new FormData()
    formData.append('file', file)
    return upload<ExpressionConfig>(`${basePath(characterId)}/upload-zip`, formData)
  },

  fromGallery(characterId: string, mappings: Record<string, string>): Promise<ExpressionConfig> {
    return post<ExpressionConfig>(`${basePath(characterId)}/from-gallery`, { mappings })
  },

  removeLabel(characterId: string, label: string): Promise<ExpressionConfig> {
    return del<ExpressionConfig>(`${basePath(characterId)}/${encodeURIComponent(label)}`)
  },

  imageUrl(imageId: string): string {
    return `${BASE_URL}/images/${imageId}`
  },

  thumbnailUrl(imageId: string): string {
    return `${BASE_URL}/images/${imageId}?thumb=true`
  },
}
