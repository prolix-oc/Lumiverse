import { embeddingsApi } from '@/api/embeddings'
import { worldBooksApi } from '@/api/world-books'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'

type CandidateBook = {
  id: string
  name: string
}

function needsInitialIndex(summary: { enabled_non_empty: number; indexed: number }): boolean {
  return summary.enabled_non_empty > 0 && summary.indexed === 0
}

function promptToIndex(books: CandidateBook[]): Promise<boolean> {
  const { openModal } = useStore.getState()
  const noun = books.length === 1 ? 'lorebook' : 'lorebooks'
  const pronoun = books.length === 1 ? 'it' : 'them'
  const setupPhrase = books.length === 1 ? 'is set up' : 'are set up'
  const missingPhrase = books.length === 1 ? 'does not have' : 'do not have'

  return new Promise((resolve) => {
    openModal('confirm', {
      title: books.length === 1 ? 'Index This Lorebook?' : 'Index These Lorebooks?',
      variant: 'warning',
      confirmText: 'Index now',
      cancelText: 'Use another lorebook',
      message: (
        <div>
          <p>
            The selected {noun} {setupPhrase} for vector activation, but {pronoun} {missingPhrase} an index yet.
            Index {pronoun} now so vector lookup is ready as soon as {books.length === 1 ? 'this lorebook is' : 'these lorebooks are'} attached to chat context.
          </p>
          <p>{books.map((book) => book.name).join(', ')}</p>
          <p>Cancel keeps {books.length === 1 ? 'this lorebook' : 'these lorebooks'} unattached so you can pick a different one.</p>
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
    toast.success(indexed === 1 ? `Indexed "${needsIndex[0].name}".` : `Indexed ${indexed} lorebooks.`)
  }
  if (failed > 0) {
    toast.error(failed === 1 ? 'A lorebook could not be indexed automatically.' : `${failed} lorebooks could not be indexed automatically.`)
  }

  return books.map((book) => book.id)
}
