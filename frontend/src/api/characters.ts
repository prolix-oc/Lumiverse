import { get, post, put, del, upload, uploadWithProgress, getBlob, BASE_URL } from './client'
import { triggerBlobDownload } from '@/lib/downloads'
import type {
  Character,
  CharacterPerspectiveLayer,
  CharacterSummary,
  TagCount,
  CreateCharacterInput,
  UpdateCharacterInput,
  PaginatedResult,
  ImportResult,
  BulkImportResult,
  BatchDeleteResult,
  TagLibraryImportResult,
} from '@/types/api'

export interface SummaryParams {
  limit?: number
  offset?: number
  search?: string
  tags?: string
  exclude_tags?: string
  sort?: string
  direction?: string
  filter?: string
  favorite_ids?: string
  seed?: number
}

export type CharacterPerspectiveLayerKind = 'background' | 'framing' | 'subject'
export type CharacterPerspectiveLayerInput = Pick<CharacterPerspectiveLayer, 'id' | 'image_id' | 'intensity'> & { label?: string }

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

  uploadAvatar(id: string, file: File, onProgress?: (percent: number) => void, originalFile?: File) {
    const form = new FormData()
    form.append('avatar', file)
    if (originalFile) form.append('original_avatar', originalFile)
    if (onProgress) {
      return uploadWithProgress<Character>(`/characters/${id}/avatar`, form, onProgress)
    }
    return upload<Character>(`/characters/${id}/avatar`, form)
  },

  uploadPerspectiveLayer(id: string, layer: CharacterPerspectiveLayerKind, file: File, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('image', file)
    const path = `/characters/${id}/perspective-layers/${layer}`
    if (onProgress) return uploadWithProgress<Character>(path, form, onProgress)
    return upload<Character>(path, form)
  },

  deletePerspectiveLayer(id: string, layer: CharacterPerspectiveLayerKind) {
    return del<Character>(`/characters/${id}/perspective-layers/${layer}`)
  },

  addPerspectiveLayer(id: string, file: File, input?: { label?: string; intensity?: number }, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('image', file)
    if (input?.label) form.append('label', input.label)
    if (typeof input?.intensity === 'number') form.append('intensity', String(input.intensity))
    if (onProgress) return uploadWithProgress<Character>(`/characters/${id}/perspective-layers`, form, onProgress)
    return upload<Character>(`/characters/${id}/perspective-layers`, form)
  },

  updatePerspectiveLayers(id: string, layers: CharacterPerspectiveLayerInput[]) {
    return put<Character>(`/characters/${id}/perspective-layers`, { layers })
  },

  removePerspectiveLayer(id: string, layerId: string) {
    return del<Character>(`/characters/${id}/perspective-layers/${layerId}`)
  },

  avatarUrl(id: string) {
    return `${BASE_URL}/characters/${id}/avatar`
  },

  getAvatarBlob(id: string) {
    return getBlob(`/characters/${id}/avatar`)
  },

  /** Direct image URL — bypasses character DB lookup when image_id is known */
  imageUrl(imageId: string) {
    return `${BASE_URL}/images/${imageId}`
  },

  importFile(file: File, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('file', file)
    if (onProgress) {
      return uploadWithProgress<ImportResult>('/characters/import', form, onProgress)
    }
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

  importTagLibrary(file: File) {
    const form = new FormData()
    form.append('file', file)
    return upload<TagLibraryImportResult>('/characters/import-tag-library', form, { timeout: 0 })
  },

  batchDelete(ids: string[], keepChats = false) {
    return post<BatchDeleteResult>('/characters/batch-delete', { ids, keep_chats: keepChats })
  },

  async exportCharacter(id: string, format: 'json' | 'png' | 'charx', characterName?: string) {
    const blob = await getBlob(`/characters/${id}/export`, { format })
    const ext = format === 'charx' ? 'charx' : format
    const safeName = (characterName || 'character').replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    triggerBlobDownload(blob, `${safeName}.${ext}`)
  },

  getResolvedFields(id: string, chatId?: string) {
    const params: Record<string, any> = {}
    if (chatId) params.chat_id = chatId
    return get<Record<string, { content: string; variant_id: string | null; label: string }>>(
      `/characters/${id}/resolved-fields`, params
    )
  },

  getImageGenLora(id: string) {
    return get<{ binding: CharacterLoraBinding | null }>(`/characters/${id}/image-gen-lora`)
  },

  setImageGenLora(id: string, input: SetCharacterLoraInput) {
    return put<{ binding: CharacterLoraBinding }>(`/characters/${id}/image-gen-lora`, input)
  },

  deleteImageGenLora(id: string) {
    return del<{ success: boolean }>(`/characters/${id}/image-gen-lora`)
  },
}

export interface CharacterLoraBinding {
  lora_name: string
  weight_model: number
  weight_clip: number
  base_tags?: string
  source_url?: string
  bound_at: number
}

export interface SetCharacterLoraInput {
  lora_name: string
  weight_model?: number
  weight_clip?: number
  base_tags?: string
  source_url?: string
}
