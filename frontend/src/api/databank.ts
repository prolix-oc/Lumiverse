import { get, post, put, del, patch, upload } from './client'

export interface Databank {
  id: string
  userId: string
  name: string
  description: string
  scope: 'global' | 'character' | 'chat'
  scopeId: string | null
  enabled: boolean
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  documentCount?: number
}

export interface DatabankDocument {
  id: string
  databankId: string
  userId: string
  name: string
  slug: string
  filePath: string
  mimeType: string
  fileSize: number
  contentHash: string
  totalChunks: number
  status: 'pending' | 'processing' | 'ready' | 'error'
  errorMessage: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

export interface AutocompleteResult {
  slug: string
  name: string
  databankId: string
  databankName: string
}

export interface SearchResult {
  chunkId: string
  documentId: string
  databankId: string
  documentName: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

const LONG = { timeout: 60_000 }

export const databankApi = {
  // Banks
  list(params?: { scope?: string; scope_id?: string; limit?: number; offset?: number }) {
    return get<PaginatedResult<Databank>>('/databanks', params)
  },
  get(id: string) {
    return get<Databank>(`/databanks/${id}`)
  },
  create(input: { name: string; description?: string; scope: string; scope_id?: string }) {
    return post<Databank>('/databanks', input)
  },
  update(id: string, input: { name?: string; description?: string; enabled?: boolean }) {
    return put<Databank>(`/databanks/${id}`, input)
  },
  delete(id: string) {
    return del<void>(`/databanks/${id}`)
  },

  // Documents
  listDocuments(bankId: string, params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<DatabankDocument>>(`/databanks/${bankId}/documents`, params)
  },
  getDocument(bankId: string, docId: string) {
    return get<DatabankDocument>(`/databanks/${bankId}/documents/${docId}`)
  },
  getDocumentContent(bankId: string, docId: string) {
    return get<{ content: string }>(`/databanks/${bankId}/documents/${docId}/content`, undefined, LONG)
  },
  uploadDocument(bankId: string, file: File) {
    const form = new FormData()
    form.append('file', file)
    return upload<DatabankDocument>(`/databanks/${bankId}/documents`, form)
  },
  renameDocument(bankId: string, docId: string, name: string) {
    return patch<DatabankDocument>(`/databanks/${bankId}/documents/${docId}`, { name })
  },
  deleteDocument(bankId: string, docId: string) {
    return del<void>(`/databanks/${bankId}/documents/${docId}`)
  },
  reprocessDocument(bankId: string, docId: string) {
    return post<{ success: boolean }>(`/databanks/${bankId}/documents/${docId}/reprocess`)
  },

  // Scrape URL
  scrapeUrl(bankId: string, url: string) {
    return post<DatabankDocument & { scraped: { title: string; sourceType: string; contentLength: number } }>(
      `/databanks/${bankId}/documents/scrape`,
      { url },
      LONG,
    )
  },

  // Chat attachment — upload doc to auto-created/existing chat databank
  attachToChat(file: File, chatId: string, chatName?: string) {
    const form = new FormData()
    form.append('file', file)
    form.append('chat_id', chatId)
    if (chatName) form.append('chat_name', chatName)
    return upload<{ document: DatabankDocument; databank: import('./databank').Databank }>(
      '/databanks/attach-to-chat',
      form,
    )
  },

  // Search
  search(params: { query: string; chatId?: string; characterId?: string; limit?: number }) {
    return post<{ data: SearchResult[] }>('/databanks/search', params)
  },

  // Autocomplete for # mentions
  autocomplete(params: { q: string; chatId?: string; characterId?: string }) {
    return get<{ data: AutocompleteResult[] }>('/databanks/mentions/autocomplete', params)
  },
}
