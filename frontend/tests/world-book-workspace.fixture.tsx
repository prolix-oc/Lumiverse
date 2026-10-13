import { useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import WorldBookEntriesSection from '../src/components/shared/WorldBookEntriesSection'
import panelStyles from '../src/components/panels/world-book/WorldBookPanel.module.css'
import WorldBookEditorModal from '../src/components/modals/WorldBookEditorModal'
import type { WorldBookEntry } from '../src/types/api'
const noop = () => {}
const listeners = new Set<() => void>()
const reorderFixture = new URLSearchParams(location.search).has('reorderFixture')
const state: any = { modalProps: { bookId: reorderFixture ? 'b5' : 'b1' }, activeChatId: null, worldBookEntryViewPrefs: reorderFixture ? JSON.parse(sessionStorage.getItem('entryViewPrefs') || '{}') : {}, pendingWorldBookEditEntryId: null, closeModal: () => { document.documentElement.dataset.closeAttempts = String(Number(document.documentElement.dataset.closeAttempts || 0) + 1) }, setSetting: (key: string, value: any) => { if (!reorderFixture) return; state[key] = value; if (reorderFixture && key === 'worldBookEntryViewPrefs') sessionStorage.setItem('entryViewPrefs', JSON.stringify(value)); for (const listener of listeners) listener() }, setPendingWorldBookEditEntryId: noop, loom: {}, theme: {}, settings: {} }
export const useStore = Object.assign((selector: any) => useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback) }, () => selector(state)), { getState: () => state })
export const useWorldBookListLiveSync = () => ({ markLocalBookEdit: noop })
export const useFolders = () => ({ folders: [], createFolder: noop, renameFolder: noop, deleteFolder: noop })
export const wsClient = { on: () => noop }
export const useTokenCounts = () => { if (reorderFixture) document.documentElement.dataset.rowRenders = String(Number(document.documentElement.dataset.rowRenders || 0) + 1); return { count: null, approximate: true, status: 'idle', requestCount: noop, cancel: noop } }
export const useTokenCountSweep = noop
export const invalidateTokenCountsForEntry = noop
export default function Empty() { return null }
export const getMacroCatalog = async () => []
export const getAvailableMacros = () => []
export const Trans = () => null
const t = (key: string, values?: any) => values?.count !== undefined ? `${key} (${values.count})` : key
export const useTranslation = () => ({ t, i18n: { language: 'en' } })
const books = [1, 0, 44, 50, reorderFixture ? 251 : 137].map((count, i) => ({ id: `b${i + 1}`, name: `Fixture book ${count}`, description: '', folder: '', entry_count: count, created_at: 0, updated_at: 0, metadata: {} }))
const flatBook = new URLSearchParams(location.search).has('flatBook')
const searchFixture = new URLSearchParams(location.search).has('searchFixture')
const rows: WorldBookEntry[] = books.flatMap(book => Array.from({ length: book.entry_count }, (_, index) => ({
  id: `${book.id}-e${index}`, world_book_id: book.id, uid: String(index), key: [], keysecondary: [], comment: searchFixture && index === book.entry_count - 1 ? 'Dragon' : `Fixture entry ${index}`, content: searchFixture ? 'A dragon appears in the background' : 'Controlled fixture content', folder: !flatBook && index % 2 ? 'Characters' : '', tags: flatBook ? [] : index % 2 ? ['a,b', 'Villain'] : ['a,b'], revision: 1,
  position: 0, depth: 4, role: null, order_value: index, priority: index, selective: false, constant: false, disabled: false, group_name: '', group_override: false, group_weight: 100, probability: 100, scan_depth: null, case_sensitive: false, match_whole_words: false, automation_id: null, use_regex: false, prevent_recursion: false, exclude_recursion: false, delay_until_recursion: false, sticky: 0, cooldown: 0, delay: 0, selective_logic: 0, use_probability: false, vectorized: false, vector_index_status: 'not_enabled', vector_indexed_at: null, vector_index_error: null, extensions: {}, created_at: 0, updated_at: 0, outlet_name: null, wi_marker: null, wi_marker_side: null,
})))
export const worldBooksApi = {
  list: async () => ({ data: books, total: books.length }),
  update: async (id: string, value: any) => Object.assign(books.find(book => book.id === id)!, value),
  getVectorSummary: async (id: string) => ({ enabled: id === 'b5' ? 2 : 0, enabled_non_empty: 0, non_empty: 0, indexed: 0, pending: id === 'b5' ? 1 : 0, error: id === 'b5' ? 1 : 0 }),
  listEntries: async (id: string, input: any) => { const data = rows.filter(row => row.world_book_id === id && (input.folder === undefined || row.folder === input.folder) && (input.tag ?? []).every((tag: string) => row.tags.includes(tag)) && (!input.search || row.comment.includes(input.search))); if (reorderFixture) data.sort((a, b) => input.sort_by === 'name' ? a.comment.localeCompare(b.comment) * (input.sort_dir === 'desc' ? -1 : 1) : a.order_value - b.order_value); return { data: data.slice(input.offset, input.offset + input.limit), total: data.length } },
  getEntryOrganization: async (id: string) => { const data = rows.filter(row => row.world_book_id === id); return { total: data.length, unfiled: data.filter(row => !row.folder).length, folders: data.some(row => row.folder) ? [{ name: 'Characters', count: data.filter(row => row.folder).length }] : [], tags: flatBook ? [] : [{ name: 'a,b', count: data.length }, { name: 'Villain', count: data.filter(row => row.tags.includes('Villain')).length }] } },
  getEntry: async (_id: string, entryId: string) => rows.find(row => row.id === entryId),
  updateEntry: async (_id: string, entryId: string, value: any) => { const row = rows.find(row => row.id === entryId)!; Object.assign(row, value); row.revision++; return { ...row } },
  reorderEntries: async (id: string, input: { ordered_ids: string[]; expected_revisions: Record<string, number> }) => {
    const data = rows.filter(row => row.world_book_id === id)
    if (input.ordered_ids.length !== data.length || new Set(input.ordered_ids).size !== data.length || data.some(row => input.expected_revisions[row.id] !== row.revision)) throw new Error('Incomplete reorder fixture payload')
    for (const row of data) { row.order_value = input.ordered_ids.indexOf(row.id); row.revision++ }
    document.documentElement.dataset.reorder = JSON.stringify(input)
    return { success: true }
  },
  setEntryExtensionNamespace: async () => ({}),
}
const scale = new URLSearchParams(location.search).get('scale') || '1'
document.documentElement.style.setProperty('--lumiverse-ui-scale', scale)
if (new URLSearchParams(location.search).get('surface') === 'sidebar') document.getElementById('root')!.style.height = '100%'
function SidebarFixture() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = Number(new URLSearchParams(location.search).get('sidebarWidth') || 440)
  return <div className={panelStyles.panel} style={{ width: `min(100%, ${width}px)`, height: '100%', ...(reorderFixture ? { position: 'fixed', right: 0, top: 'var(--app-interactive-safe-top, 0px)', bottom: 0, height: 'calc(100% - var(--app-interactive-safe-top, 0px))', transform: 'translateX(0)' } : {}) }}>
    <div ref={scrollRef} className={panelStyles.panelScroll} data-sidebar-scroll>
      <WorldBookEntriesSection books={books} selectedBookId={searchFixture || reorderFixture ? 'b5' : 'b3'} editorDensity="compact" scrollContainerRef={scrollRef} />
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('surface') === 'sidebar' ? <SidebarFixture /> : <WorldBookEditorModal />)
