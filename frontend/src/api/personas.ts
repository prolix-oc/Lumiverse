import { get, post, put, del, upload, BASE_URL } from './client'
import type { Persona, CreatePersonaInput, UpdatePersonaInput, PaginatedResult, RenamePersonaFolderResponse, DeletePersonaFolderResponse } from '@/types/api'

export const personasApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<Persona>>('/personas', params)
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

  duplicate(id: string) {
    return post<Persona>(`/personas/${id}/duplicate`)
  },

  uploadAvatar(id: string, file: File) {
    const form = new FormData()
    form.append('avatar', file)
    return upload<Persona>(`/personas/${id}/avatar`, form)
  },

  avatarUrl(id: string) {
    return `${BASE_URL}/personas/${id}/avatar`
  },
}
