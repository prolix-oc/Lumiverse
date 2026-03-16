import { get, post, put, del } from './client'
import type { Preset, PresetRegistryItem, CreatePresetInput, UpdatePresetInput, PaginatedResult } from '@/types/api'

export const presetsApi = {
  list(params?: { limit?: number; offset?: number; provider?: string }) {
    return get<PaginatedResult<Preset>>('/presets', params)
  },

  listRegistry(params?: { limit?: number; offset?: number; provider?: string; engine?: string }) {
    return get<PaginatedResult<PresetRegistryItem>>('/presets/registry', params)
  },

  get(id: string) {
    return get<Preset>(`/presets/${id}`)
  },

  create(input: CreatePresetInput) {
    return post<Preset>('/presets', input)
  },

  update(id: string, input: UpdatePresetInput) {
    return put<Preset>(`/presets/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/presets/${id}`)
  },
}
