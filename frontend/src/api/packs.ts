import { get, post, put, del } from './client'
import type {
  Pack, PackWithItems,
  LumiaItem, LoomItem, LoomTool,
  CreatePackInput, UpdatePackInput,
  CreateLumiaItemInput, UpdateLumiaItemInput,
  CreateLoomItemInput, UpdateLoomItemInput,
  CreateLoomToolInput, UpdateLoomToolInput,
  PaginatedResult,
} from '@/types/api'

export const packsApi = {
  // Pack CRUD
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<Pack>>('/packs', params)
  },

  get(id: string) {
    return get<PackWithItems>(`/packs/${id}`)
  },

  create(input: CreatePackInput) {
    return post<Pack>('/packs', input)
  },

  update(id: string, input: UpdatePackInput) {
    return put<Pack>(`/packs/${id}`, input)
  },

  delete(id: string) {
    return del<{ success: boolean }>(`/packs/${id}`)
  },

  // Import / Export
  importJson(payload: Record<string, any>) {
    return post<PackWithItems>('/packs/import', payload)
  },

  importUrl(url: string) {
    return post<PackWithItems>('/packs/import-url', { url })
  },

  export(id: string) {
    return get<Record<string, any>>(`/packs/${id}/export`)
  },

  // Lucid Cards
  lucidCardsList() {
    return get<any>('/packs/lucid-cards')
  },

  lucidCardsImport(slug: string) {
    return post<PackWithItems>('/packs/lucid-cards/import', { slug })
  },

  // Lumia Items
  createLumiaItem(packId: string, input: CreateLumiaItemInput) {
    return post<LumiaItem>(`/packs/${packId}/lumia-items`, input)
  },

  updateLumiaItem(packId: string, itemId: string, input: UpdateLumiaItemInput) {
    return put<LumiaItem>(`/packs/${packId}/lumia-items/${itemId}`, input)
  },

  deleteLumiaItem(packId: string, itemId: string) {
    return del<{ success: boolean }>(`/packs/${packId}/lumia-items/${itemId}`)
  },

  // Loom Items
  createLoomItem(packId: string, input: CreateLoomItemInput) {
    return post<LoomItem>(`/packs/${packId}/loom-items`, input)
  },

  updateLoomItem(packId: string, itemId: string, input: UpdateLoomItemInput) {
    return put<LoomItem>(`/packs/${packId}/loom-items/${itemId}`, input)
  },

  deleteLoomItem(packId: string, itemId: string) {
    return del<{ success: boolean }>(`/packs/${packId}/loom-items/${itemId}`)
  },

  // Loom Tools
  createLoomTool(packId: string, input: CreateLoomToolInput) {
    return post<LoomTool>(`/packs/${packId}/loom-tools`, input)
  },

  updateLoomTool(packId: string, toolId: string, input: UpdateLoomToolInput) {
    return put<LoomTool>(`/packs/${packId}/loom-tools/${toolId}`, input)
  },

  deleteLoomTool(packId: string, toolId: string) {
    return del<{ success: boolean }>(`/packs/${packId}/loom-tools/${toolId}`)
  },
}
