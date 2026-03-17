import { get, post, put, del, upload, BASE_URL } from './client'
import type {
  Character,
  CharacterSummary,
  TagCount,
  CreateCharacterInput,
  UpdateCharacterInput,
  PaginatedResult,
  ImportResult,
  BulkImportResult,
  BatchDeleteResult,
} from '@/types/api'

export interface SummaryParams {
  limit?: number
  offset?: number
  search?: string
  tags?: string
  sort?: string
  direction?: string
  filter?: string
  favorite_ids?: string
  seed?: number
}

export const charactersApi = {
  list(params?: { limit?: number; offset?: number; search?: string; sort?: string; seed?: number }) {
    return get<PaginatedResult<Character>>('/characters', params)
  },

  listSummaries(params?: SummaryParams) {
    return get<PaginatedResult<CharacterSummary>>('/characters/summary', params)
  },

  listTags() {
    return get<TagCount[]>('/characters/tags')
  },

  get(id: string) {
    return get<Character>(`/characters/${id}`)
  },

  create(input: CreateCharacterInput) {
    return post<Character>('/characters', input)
  },

  update(id: string, input: UpdateCharacterInput) {
    return put<Character>(`/characters/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/characters/${id}`)
  },

  duplicate(id: string) {
    return post<Character>(`/characters/${id}/duplicate`)
  },

  uploadAvatar(id: string, file: File) {
    const form = new FormData()
    form.append('avatar', file)
    return upload<Character>(`/characters/${id}/avatar`, form)
  },

  avatarUrl(id: string) {
    return `${BASE_URL}/characters/${id}/avatar`
  },

  /** Direct image URL — bypasses character DB lookup when image_id is known */
  imageUrl(imageId: string) {
    return `${BASE_URL}/images/${imageId}`
  },

  importFile(file: File) {
    const form = new FormData()
    form.append('file', file)
    return upload<ImportResult>('/characters/import', form)
  },

  importUrl(url: string) {
    return post<ImportResult>('/characters/import-url', { url })
  },

  importBulk(files: File[], skipDuplicates = false) {
    const form = new FormData()
    for (const file of files) {
      form.append('files', file)
    }
    if (skipDuplicates) {
      form.append('skip_duplicates', 'true')
    }
    return upload<BulkImportResult>('/characters/import-bulk', form)
  },

  batchDelete(ids: string[], keepChats = false) {
    return post<BatchDeleteResult>('/characters/batch-delete', { ids, keep_chats: keepChats })
  },
}
