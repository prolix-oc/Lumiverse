import { get, post, put, del, upload, BASE_URL } from './client'
import type { Persona, CreatePersonaInput, UpdatePersonaInput, PaginatedResult, RenamePersonaFolderResponse, DeletePersonaFolderResponse } from '@/types/api'

export const personasApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<Persona>>('/personas', params)
  },

  async listAll() {
    const pageSize = 200
    const data: Persona[] = []
    let offset = 0
    let total = Number.POSITIVE_INFINITY

    while (offset < total) {
      const page = await get<PaginatedResult<Persona>>('/personas', { limit: pageSize, offset })
      data.push(...page.data)
      total = page.total
      if (page.data.length === 0) break
      offset += page.data.length
    }

    return data
  },

  get(id: string) {
    return get<Persona>(`/personas/${id}`)
  },

  create(input: CreatePersonaInput) {
    return post<Persona>('/personas', input)
  },

  renameFolder(oldName: string, newName: string) {
    return post<RenamePersonaFolderResponse>('/personas/folders/rename', {
      old_name: oldName,
      new_name: newName,
    })
  },

  deleteFolder(name: string) {
    return post<DeletePersonaFolderResponse>('/personas/folders/delete', { name })
  },

  update(id: string, input: UpdatePersonaInput) {
    return put<Persona>(`/personas/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/personas/${id}`)
  },

  bulkUpdate(ids: string[], input: {
    folder?: string
    attached_world_book_id?: string | null
    toggle_narrator?: boolean
  }) {
    return post<{ updated: Persona[]; count: number }>('/personas/bulk-update', { ids, ...input })
  },

  bulkDelete(ids: string[]) {
    return post<{ deleted: string[]; count: number }>('/personas/bulk-delete', { ids })
  },

  duplicate(id: string) {
    return post<Persona>(`/personas/${id}/duplicate`)
  },

  uploadAvatar(id: string, file: File, originalFile?: File) {
    const form = new FormData()
    form.append('avatar', file)
    if (originalFile) form.append('original_avatar', originalFile)
    return upload<Persona>(`/personas/${id}/avatar`, form)
  },

  avatarUrl(id: string) {
    return `${BASE_URL}/personas/${id}/avatar`
  },
}
