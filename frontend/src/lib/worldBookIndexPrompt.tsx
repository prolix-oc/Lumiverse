import { embeddingsApi } from '@/api/embeddings'
import { worldBooksApi } from '@/api/world-books'
import i18n from '@/i18n'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'

type CandidateBook = {
  id: string
  name: string
}

const wb = (key: string, options?: Record<string, unknown>) =>
  i18n.t(`modals:worldBookIndex.${key}`, options)

function needsInitialIndex(summary: { enabled_non_empty: number; indexed: number }): boolean {
  return summary.enabled_non_empty > 0 && summary.indexed === 0
}

function promptToIndex(books: CandidateBook[]): Promise<boolean> {
  const { openModal } = useStore.getState()
  const one = books.length === 1

  return new Promise((resolve) => {
    openModal('confirm', {
      title: one ? wb('titleOne') : wb('titleMany'),
      variant: 'warning',
      confirmText: wb('confirm'),
      cancelText: wb('cancel'),
      message: (
        <div>
          <p>{one ? wb('bodyOne') : wb('bodyMany')}</p>
          <p>{books.map((book) => book.name).join(', ')}</p>
          <p>{one ? wb('cancelHintOne') : wb('cancelHintMany')}</p>
        </div>
      ),
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}

export async function filterWorldBooksForChatContextAttachment(books: CandidateBook[]): Promise<string[]> {
  if (books.length === 0) return []

  try {
    const config = await embeddingsApi.getConfig()
    if (!config.enabled || !config.has_api_key || !config.vectorize_world_books) {
      return books.map((book) => book.id)
    }
  } catch {
    return books.map((book) => book.id)
  }

  const summaries = await Promise.all(
    books.map(async (book) => {
      try {
        const summary = await worldBooksApi.getVectorSummary(book.id)
        return { book, summary }
      } catch {
        return { book, summary: null }
      }
    }),
  )

  const needsIndex = summaries
    .filter((item) => item.summary && needsInitialIndex(item.summary))
    .map((item) => item.book)

  if (needsIndex.length === 0) {
    return books.map((book) => book.id)
  }

  const shouldIndex = await promptToIndex(needsIndex)
  if (!shouldIndex) {
    const rejectedIds = new Set(needsIndex.map((book) => book.id))
    return books.filter((book) => !rejectedIds.has(book.id)).map((book) => book.id)
  }

  let indexed = 0
  let failed = 0
  for (const book of needsIndex) {
    try {
      await worldBooksApi.reindexVectors(book.id)
      indexed += 1
    } catch (err) {
      failed += 1
      console.warn('[world-books] Failed to auto-index attached lorebook:', err)
    }
  }

  if (indexed > 0) {
    toast.success(
      indexed === 1
        ? wb('toastIndexedOne', { name: needsIndex[0].name })
        : wb('toastIndexedMany', { count: indexed }),
    )
  }
  if (failed > 0) {
    toast.error(failed === 1 ? wb('toastFailedOne') : wb('toastFailedMany', { count: failed }))
  }

  return books.map((book) => book.id)
}
