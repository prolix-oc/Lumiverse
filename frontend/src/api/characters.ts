import { get, post, put, del, upload, uploadRaw, uploadWithProgress, getBlob, BASE_URL, type RequestOptions } from './client'
import { triggerBlobDownload, triggerUrlDownload } from '@/lib/downloads'
import { uuidv4 } from '@/lib/uuid'
import { completeDeletion } from '@/lib/deletion-completion'
import type { DeletionOperation } from '@/lib/deletion-events'
import type { CharacterIndexItem } from '@/types/api'
import { shareRead } from '@/lib/shared-read'

/** Ceiling for calls that may download a full expression pack (~20 MB). */
const EXPRESSION_FETCH_TIMEOUT_MS = 5 * 60 * 1000
import type {
  Character,
  CharacterLibraryScope,
  CharacterPreview,
  CharacterPerspectiveLayer,
  CharacterSummary,
  TagCount,
  CreateCharacterInput,
  UpdateCharacterInput,
  PaginatedResult,
  ImportResult,
  BulkImportResult,
  CharacterImportJob,
  BatchDeleteResult,
  BulkTagResult,
  TagLibraryImportResult,
  CharacterFolderMutationResponse,
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
  chat_id?: string
  scope?: CharacterLibraryScope
}

export type CharacterPerspectiveLayerKind = 'background' | 'framing' | 'subject'
export type CharacterPerspectiveLayerInput = Pick<CharacterPerspectiveLayer, 'id' | 'image_id' | 'intensity'> & { label?: string }

export const charactersApi = {
  getBatch(ids: string[], options?: RequestOptions) {
    return get<Character[]>('/characters/details', { ids: ids.join(',') }, options)
  },
  listIndex(generation = 0) {
    return shareRead(`character-index:${generation}`, async () => {
      const data: CharacterIndexItem[] = []
      for (;;) {
        const page = await get<PaginatedResult<CharacterIndexItem>>('/characters/index', { limit: 1000, offset: data.length })
        data.push(...page.data)
        if (data.length >= page.total || page.data.length === 0) return data
      }
    })
  },
  list(params?: { limit?: number; offset?: number; search?: string; sort?: string; seed?: number }) {
    return get<PaginatedResult<Character>>('/characters', params)
  },

  listSummaries(params?: SummaryParams, signal?: AbortSignal) {
    const options: RequestOptions | undefined = signal === undefined ? undefined : { signal }
    return get<PaginatedResult<CharacterSummary>>('/characters/summary', params, options)
  },

  getHomepagePreview(id: string, signal?: AbortSignal) {
    const options: RequestOptions | undefined = signal === undefined ? undefined : { signal }
    return get<CharacterPreview>(`/characters/${id}/homepage-preview`, undefined, options)
  },

  listTags() {
    return get<TagCount[]>('/characters/tags')
  },

  get(id: string, options?: RequestOptions) {
    return get<Character>(`/characters/${id}`, undefined, options)
  },

  create(input: CreateCharacterInput) {
    return post<Character>('/characters', input)
  },

  update(id: string, input: UpdateCharacterInput) {
    return put<Character>(`/characters/${id}`, input)
  },

  delete(id: string) {
    const operationId = uuidv4()
    return completeDeletion({
      operationId, entityId: id,
      request: (signal) => del<DeletionOperation>(`/characters/${encodeURIComponent(id)}?operation_id=${operationId}`, { signal }),
      readStatus: (signal) => charactersApi.getDeletionOperation(operationId, signal),
    })
  },

  async getDeletionOperation(operationId: string, signal?: AbortSignal) {
    try { return await get<DeletionOperation>(`/characters/deletions/${encodeURIComponent(operationId)}`, undefined, { signal }) }
    catch (error: any) { if (error?.status === 404) return null; throw error }
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

  replaceCard(id: string, file: File, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('file', file)
    if (onProgress) return uploadWithProgress<Character>(`/characters/${id}/replace-card`, form, onProgress)
    return upload<Character>(`/characters/${id}/replace-card`, form)
  },

  importUrl(url: string) {
    // Importing may also pull a gallery and an expression pack, so this shares
    // the longer ceiling rather than the default 30s.
    return post<ImportResult>('/characters/import-url', { url }, { timeout: EXPRESSION_FETCH_TIMEOUT_MS })
  },

  /**
   * Pull this character's expression pack from the Chub source it came from.
   *
   * A pack is tens of images and can take minutes on a slow link, so the
   * default 30s ceiling would abort a download that was progressing fine.
   */
  fetchChubExpressions(id: string) {
    return post<{ imported: number; skipped: number; available: number; sourceMissing?: boolean }>(
      `/characters/${id}/chub-expressions`,
      undefined,
      { timeout: EXPRESSION_FETCH_TIMEOUT_MS },
    )
  },

  /** Characters that trace back to Chub and have no expressions yet. */
  chubExpressionCandidates() {
    return get<{ candidates: Array<{ id: string; name: string }>; count: number }>(
      '/characters/chub-expression-candidates',
    )
  },

  importBulk(files: File[], skipDuplicates = false) {
    const form = new FormData()
    for (const file of files) {
      form.append('files', file)
    }
    if (skipDuplicates) {
      form.append('skip_duplicates', 'true')
    }
    return upload<BulkImportResult>('/characters/import-bulk', form, { timeout: 0 })
  },

  createImportJob(total: number, skipDuplicates = false) {
    return post<CharacterImportJob>('/characters/import-jobs', {
      total,
      skip_duplicates: skipDuplicates,
    })
  },

  uploadImportJobFile(jobId: string, index: number, file: File, signal?: AbortSignal) {
    const filename = encodeURIComponent(file.name || `character-${index + 1}`)
    return uploadRaw<CharacterImportJob>(
      `/characters/import-jobs/${encodeURIComponent(jobId)}/files/${index}?filename=${filename}`,
      file,
      { timeout: 0, signal, contentType: file.type || 'application/octet-stream' },
    )
  },

  startImportJob(jobId: string) {
    return post<CharacterImportJob>(`/characters/import-jobs/${encodeURIComponent(jobId)}/start`)
  },

  getImportJob(jobId: string, signal?: AbortSignal) {
    const options: RequestOptions | undefined = signal === undefined ? undefined : { signal }
    return get<CharacterImportJob>(`/characters/import-jobs/${encodeURIComponent(jobId)}/status`, undefined, options)
  },

  cancelImportJob(jobId: string) {
    return post<CharacterImportJob>(`/characters/import-jobs/${encodeURIComponent(jobId)}/cancel`)
  },

  importTagLibrary(file: File) {
    const form = new FormData()
    form.append('file', file)
    return upload<TagLibraryImportResult>('/characters/import-tag-library', form, { timeout: 0 })
  },

  batchDelete(ids: string[], keepChats = false) {
    return post<BatchDeleteResult>('/characters/batch-delete', { ids, keep_chats: keepChats })
  },

  bulkUpdateTags(ids: string[], operation: 'add' | 'remove' | 'replace', tags: string[]) {
    return post<BulkTagResult>('/characters/bulk-tags', { ids, operation, tags })
  },

  renameFolder(oldName: string, newName: string) {
    return post<CharacterFolderMutationResponse>('/characters/folders/rename', {
      old_name: oldName,
      new_name: newName,
    })
  },

  deleteFolder(name: string) {
    return post<CharacterFolderMutationResponse>('/characters/folders/delete', { name })
  },

  bulkUpdateFolder(ids: string[], folder: string) {
    return post<CharacterFolderMutationResponse>('/characters/bulk-update', { ids, folder })
  },

  async exportCharacter(id: string, format: 'json' | 'png' | 'charx', characterName?: string) {
    const blob = await getBlob(`/characters/${id}/export`, { format })
    const ext = format === 'charx' ? 'charx' : format
    const safeName = (characterName || 'character').replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    await triggerBlobDownload(blob, `${safeName}.${ext}`)
  },

  /**
   * Start a CHARX download as a native browser download. Unlike fetching a
   * Blob into JavaScript, this lets the browser show its own transfer progress
   * and avoids keeping a second copy of a potentially large archive in memory.
   */
  downloadCharxExport(id: string, exportId: string, characterName?: string) {
    const safeName = (characterName || 'character').replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    const params = new URLSearchParams({ format: 'charx', export_id: exportId })
    return triggerUrlDownload(`${BASE_URL}/characters/${encodeURIComponent(id)}/export?${params.toString()}`, `${safeName}.charx`)
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
