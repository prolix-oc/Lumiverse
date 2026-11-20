import { get, post, put, del } from './client'
import type { GlobalAddon, PaginatedResult } from '@/types/api'

export const globalAddonsApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<GlobalAddon>>('/global-addons', params)
  },

  get(id: string) {
    return get<GlobalAddon>(`/global-addons/${id}`)
  },

  create(input: { label: string; content?: string; sort_order?: number }) {
    return post<GlobalAddon>('/global-addons', input)
  },

  update(id: string, input: Partial<{ label: string; content: string; sort_order: number }>) {
    return put<GlobalAddon>(`/global-addons/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/global-addons/${id}`)
  },

  duplicate(id: string) {
    return post<GlobalAddon>(`/global-addons/${id}/duplicate`)
  },

  reorder(ids: string[]) {
    return put<void>('/global-addons/reorder', { ids })
  },
}
