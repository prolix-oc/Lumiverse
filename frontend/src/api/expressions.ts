import { get, put, post, del, upload, BASE_URL } from './client'
import type { ExpressionConfig, ExpressionGroups } from '@/types/expressions'

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

  // ── Multi-character expression groups ─────────────────────────────────────

  getGroups(characterId: string): Promise<ExpressionGroups> {
    return get<ExpressionGroups>(`${basePath(characterId)}/groups`)
  },

  putGroups(characterId: string, groups: ExpressionGroups): Promise<ExpressionGroups> {
    return put<ExpressionGroups>(`${basePath(characterId)}/groups`, groups)
  },

  removeGroup(characterId: string, groupName: string): Promise<ExpressionGroups> {
    return del<ExpressionGroups>(`${basePath(characterId)}/groups/${encodeURIComponent(groupName)}`)
  },

  removeGroupLabel(characterId: string, groupName: string, label: string): Promise<ExpressionGroups> {
    return del<ExpressionGroups>(
      `${basePath(characterId)}/groups/${encodeURIComponent(groupName)}/${encodeURIComponent(label)}`
    )
  },

  addGroup(characterId: string, name: string): Promise<ExpressionGroups> {
    return post<ExpressionGroups>(`${basePath(characterId)}/groups`, { name })
  },

  addGroupLabel(characterId: string, groupName: string, label: string, imageId: string): Promise<ExpressionGroups> {
    return post<ExpressionGroups>(
      `${basePath(characterId)}/groups/${encodeURIComponent(groupName)}/labels`,
      { label, imageId }
    )
  },

  uploadGroupZip(characterId: string, groupName: string, file: File): Promise<ExpressionGroups> {
    const formData = new FormData()
    formData.append('file', file)
    return upload<ExpressionGroups>(
      `${basePath(characterId)}/groups/${encodeURIComponent(groupName)}/upload-zip`,
      formData
    )
  },

  convertToGroups(characterId: string): Promise<ExpressionGroups> {
    return post<ExpressionGroups>(`${basePath(characterId)}/groups/convert-to-groups`, {})
  },

  convertToFlat(characterId: string, groupName: string): Promise<ExpressionConfig> {
    return post<ExpressionConfig>(`${basePath(characterId)}/groups/convert-to-flat`, { groupName })
  },

  imageUrl(imageId: string): string {
    return `${BASE_URL}/images/${imageId}`
  },

  smallUrl(imageId: string): string {
    return `${BASE_URL}/images/${imageId}?size=sm`
  },
}
