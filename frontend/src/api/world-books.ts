import { get, post, put, del } from './client'
import type {
  WorldBook, CreateWorldBookInput, UpdateWorldBookInput,
  WorldBookEntry, CreateWorldBookEntryInput, UpdateWorldBookEntryInput,
  PaginatedResult
} from '@/types/api'

export const worldBooksApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<WorldBook>>('/world-books', params)
  },

  get(id: string) {
    return get<WorldBook>(`/world-books/${id}`)
  },

  create(input: CreateWorldBookInput) {
    return post<WorldBook>('/world-books', input)
  },

  update(id: string, input: UpdateWorldBookInput) {
    return put<WorldBook>(`/world-books/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/world-books/${id}`)
  },

  // Entries
  listEntries(bookId: string, params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<WorldBookEntry>>(`/world-books/${bookId}/entries`, params)
  },

  getEntry(bookId: string, entryId: string) {
    return get<WorldBookEntry>(`/world-books/${bookId}/entries/${entryId}`)
  },

  createEntry(bookId: string, input: CreateWorldBookEntryInput) {
    return post<WorldBookEntry>(`/world-books/${bookId}/entries`, input)
  },

  updateEntry(bookId: string, entryId: string, input: UpdateWorldBookEntryInput) {
    return put<WorldBookEntry>(`/world-books/${bookId}/entries/${entryId}`, input)
  },

  deleteEntry(bookId: string, entryId: string) {
    return del<void>(`/world-books/${bookId}/entries/${entryId}`)
  },

  importJson(payload: Record<string, any>) {
    return post<{ world_book: WorldBook; entry_count: number }>('/world-books/import', payload)
  },

  importUrl(url: string) {
    return post<{ world_book: WorldBook; entry_count: number }>('/world-books/import-url', { url })
  },

  importCharacterBook(characterId: string) {
    return post<{ world_book: WorldBook; entry_count: number }>('/world-books/import-character-book', { characterId })
  },

  reindexVectors(
    bookId: string,
    options?: {
      batchSize?: number
      onProgress?: (progress: { indexed: number; removed: number; failed: number; total: number; current: number }) => void
    }
  ) {
    const body: Record<string, any> = {}
    if (options?.batchSize) body.batch_size = options.batchSize

    if (options?.onProgress) {
      // SSE streaming mode
      return new Promise<{ success: boolean; indexed: number; removed: number; failed: number; total: number }>(
        async (resolve, reject) => {
          try {
            const res = await fetch(`/api/v1/embeddings/world-books/${encodeURIComponent(bookId)}/reindex`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
              },
              credentials: 'include',
              body: JSON.stringify(body),
            })
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: 'Reindex failed' }))
              reject(new Error(err.error || `HTTP ${res.status}`))
              return
            }
            const reader = res.body?.getReader()
            if (!reader) {
              reject(new Error('No response body'))
              return
            }
            const decoder = new TextDecoder()
            let buffer = ''
            let finalResult: any = null

            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })

              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              let eventType = ''
              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  eventType = line.slice(7).trim()
                } else if (line.startsWith('data: ')) {
                  const data = JSON.parse(line.slice(6))
                  if (eventType === 'progress') {
                    options.onProgress!(data)
                  } else if (eventType === 'done') {
                    finalResult = data
                  } else if (eventType === 'error') {
                    reject(new Error(data.error || 'Reindex failed'))
                    return
                  }
                }
              }
            }
            resolve(finalResult || { success: true, indexed: 0, removed: 0, failed: 0, total: 0 })
          } catch (err: any) {
            reject(err)
          }
        }
      )
    }

    // Non-streaming fallback
    return post<{ success: boolean; indexed: number; removed: number; failed: number; total: number }>(
      `/embeddings/world-books/${encodeURIComponent(bookId)}/reindex`,
      body
    )
  },
}
