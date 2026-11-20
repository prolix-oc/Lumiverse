import type { WorldBookEntry, WorldBookEntryBulkActionInput, WorldBookEntryFolderActionInput } from '../src/types/api'
export const fixtureRows = [{ id: 'e1', world_book_id: 'b1', comment: 'Fixture entry', folder: 'Characters', tags: ['a,b', 'Villain'], revision: 7 }] as WorldBookEntry[]
export const worldBooksApi = {
  getEntryOrganization: async (bookId: string) => {
    const rows = fixtureRows.filter(row => row.world_book_id === bookId)
    const folders = new Map<string, number>(), tags = new Map<string, number>()
    for (const row of rows) { folders.set(row.folder, (folders.get(row.folder) ?? 0) + 1); for (const tag of row.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1) }
    return { total: rows.length, unfiled: folders.get('') ?? 0, folders: [...folders].filter(([name]) => name).map(([name, count]) => ({ name, count })), tags: [...tags].map(([name, count]) => ({ name, count })) }
  },
  bulkEntryAction: async (_bookId: string, input: WorldBookEntryBulkActionInput) => {
    for (const row of fixtureRows.filter(row => input.entry_ids.includes(row.id))) {
      if (input.action === 'move') { row.world_book_id = input.target_book_id!; row.folder = input.target_folder! }
      if (input.action === 'add_tags') row.tags = [...new Set([...row.tags, ...(input.tags ?? [])])]
      if (input.action === 'remove_tags') row.tags = row.tags.filter(tag => !input.tags?.includes(tag))
      row.revision++
    }
    return { affected: 1 }
  },
  entryFolderAction: async (bookId: string, input: WorldBookEntryFolderActionInput) => {
    for (const row of fixtureRows.filter(row => row.world_book_id === bookId && row.folder === input.folder)) {
      row.folder = input.action === 'remove' ? '' : input.target_folder!
      if (input.action === 'move') row.world_book_id = input.target_book_id!
      row.revision++
    }
    return { affected: 1 }
  },
}
