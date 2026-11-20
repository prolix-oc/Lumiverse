import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Files, Folder, FolderOpen } from 'lucide-react'
import { ApiError } from '@/api/client'
import { worldBooksApi } from '@/api/world-books'
import type { WorldBook, WorldBookEntry, WorldBookEntryBulkActionInput, WorldBookEntryOrganizationSummary } from '@/types/api'
import styles from './EntryOrganization.module.css'

export interface EntryOrganizationHandle {
  openMove: (ids: string[], folder: string, source?: HTMLElement) => void
  openTags?: (action: 'add_tags' | 'remove_tags', ids: string[], source?: HTMLElement) => void
}

type Action = 'move' | 'rename' | 'remove' | 'move_folder' | 'add_tags' | 'remove_tags'
export function EntryFolderList({ summary, onOpen }: { summary: WorldBookEntryOrganizationSummary | null; onOpen: (folder?: string) => void }) {
  if (!summary) return <div className={styles.root} role="status">Loading folders…</div>
  return <nav className={styles.root} aria-label="Entry folders">
    <button className={styles.folderRow} type="button" onClick={() => onOpen()}><Files className={styles.folderIcon} size={18} aria-hidden="true" /><span>All entries</span><b>{summary.total}</b><ChevronRight className={styles.folderChevron} size={16} aria-hidden="true" /></button>
    <button className={styles.folderRow} type="button" onClick={() => onOpen('')}><FolderOpen className={styles.folderIcon} size={18} aria-hidden="true" /><span>Unfiled</span><b>{summary.unfiled}</b><ChevronRight className={styles.folderChevron} size={16} aria-hidden="true" /></button>
    {summary.folders.map(item => <button className={styles.folderRow} type="button" key={item.name} onClick={() => onOpen(item.name)}><Folder className={styles.folderIcon} size={18} aria-hidden="true" /><span>{item.name}</span><b>{item.count}</b><ChevronRight className={styles.folderChevron} size={16} aria-hidden="true" /></button>)}
  </nav>
}

export default function EntryOrganizationControls({ bookId, books, summary, folder, root, tags, entries, selectedIds, busy, onRoot, onTags, onReload, onFolderChanged, hideFilters = false, hideSelectionActions = false, ref }: {
  hideFilters?: boolean
  hideSelectionActions?: boolean
  ref?: Ref<EntryOrganizationHandle>
  bookId: string; books: WorldBook[]; summary: WorldBookEntryOrganizationSummary | null
  folder?: string; root: boolean; tags: string[]; entries: WorldBookEntry[]; selectedIds: string[]; busy?: boolean
  onFolderChanged?: (folder?: string) => void
  onRoot: () => void; onTags: (tags: string[]) => void; onReload: () => Promise<void>
}) {
  const hasFolders = !!summary?.folders.length
  const id = useId()
  const [action, setAction] = useState<Action | null>(null)
  const [targetBook, setTargetBook] = useState(bookId)
  const [targetFolder, setTargetFolder] = useState(folder ?? '')
  const [tagDraft, setTagDraft] = useState('')
  const [targetSummary, setTargetSummary] = useState<WorldBookEntryOrganizationSummary | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const selection = useRef<{ ids: string[]; revisions: Record<string, number> }>({ ids: [], revisions: {} })
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  const currentEntries = useRef(entries)
  currentEntries.current = entries
  useEffect(() => {
    if (!snapshotVersion) return
    const revisions = { ...selection.current.revisions }
    for (const entry of currentEntries.current) if (selection.current.ids.includes(entry.id)) revisions[entry.id] = entry.revision
    selection.current.revisions = revisions
  }, [snapshotVersion])
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (!action) return
    const node = dialog.current
    node?.showModal()
    return () => { node?.close(); trigger.current?.focus() }
  }, [action])
  useEffect(() => {
    if (targetBook === bookId) { setTargetSummary(summary); return }
    let current = true
    setTargetSummary(null)
    void worldBooksApi.getEntryOrganization(targetBook).then(value => { if (current) setTargetSummary(value) })
      .catch(() => { if (current) setError('Could not load destination folders. Retry or choose another lorebook.') })
    return () => { current = false }
  }, [bookId, summary, targetBook])
  const open = (value: Action, source: HTMLElement | null, ids = selectedIds, destination = folder ?? '') => {
    if (busy || pending || needsReload) return
    trigger.current = source
    selection.current = { ids: [...ids], revisions: Object.fromEntries(entries.filter(entry => ids.includes(entry.id)).map(entry => [entry.id, entry.revision])) }
    if (!needsReload) setError('')
    setTagDraft(''); setTargetBook(bookId); setTargetFolder(destination); setAction(value)
  }
  useImperativeHandle(ref, () => ({
    openMove: (ids, destination, source) => open('move', source ?? null, ids, destination),
    openTags: (value, ids, source) => open(value, source ?? null, ids),
  }))
  const close = () => { if (!pending) setAction(null) }
  const reload = async () => {
    setPending(true)
    try { await onReload(); if (live.current) { setNeedsReload(false); setSnapshotVersion(value => value + 1); setError('') } }
    catch { if (live.current) setError('Reload failed. Your form is retained; retry Reload before submitting again.') }
    finally { if (live.current) setPending(false) }
  }
  const submit = async () => {
    if (!action || pending || needsReload) return
    setPending(true); setError('')
    let acknowledged = false
    try {
      if (action === 'rename' || action === 'remove' || action === 'move_folder') {
        await worldBooksApi.entryFolderAction(bookId, { action: action === 'move_folder' ? 'move' : action, folder: folder!, target_folder: targetFolder.trim(), target_book_id: targetBook })
      } else {
        const expected = selection.current.revisions
        const ids = selection.current.ids
        const input: WorldBookEntryBulkActionInput = action === 'move'
          ? { action, entry_ids: ids, target_book_id: targetBook, target_folder: targetFolder.trim(), expected_revisions: expected }
          : { action, entry_ids: ids, tags: [tagDraft.trim()], expected_revisions: expected }
        await worldBooksApi.bulkEntryAction(bookId, input)
      }
      acknowledged = true
      await onReload()
      if (live.current) {
        if (action === 'rename') onFolderChanged?.(targetFolder.trim())
        else if (action === 'remove') onFolderChanged?.('')
        else if (action === 'move_folder') onFolderChanged?.(targetBook === bookId ? targetFolder.trim() : undefined)
        setAction(null)
      }
    } catch (cause) {
      if (!live.current) return
      const rejected = cause instanceof ApiError && cause.status >= 400 && cause.status < 500
      setNeedsReload(acknowledged || !rejected || (cause instanceof ApiError && cause.status === 409))
      setError(acknowledged ? 'Changes were saved, but the list could not reload. Reload before another action.'
        : rejected ? (cause instanceof ApiError ? cause.message : 'Request rejected.')
          : 'The request may have been saved. Reload before trying again.')
    } finally { if (live.current) setPending(false) }
  }
  const named = folder !== undefined && folder !== ''
  const tagAction = action === 'add_tags' || action === 'remove_tags'
  const moveAction = action === 'move' || action === 'move_folder'
  return <>
    <div className={styles.controls} hidden={!hasFolders && !summary?.tags.length && !tags.length && !needsReload && (hideSelectionActions || !selectedIds.length)}>
      {needsReload && !action && <div role="alert">{error}<button type="button" disabled={pending} onClick={() => void reload()}>Reload entries</button></div>}
      {hasFolders && root && <strong>Folders</strong>}
      {hasFolders && !root && <div className={styles.navigatorHeader}><button type="button" onClick={onRoot}>‹ Folders</button><strong>{folder === undefined ? 'All entries' : folder || 'Unfiled'}</strong></div>}
      {!root && <>
        <div hidden={hideFilters || (!summary?.tags.length && !tags.length)}>
        <label className={styles.tagFilter}>Tags <span className={styles.filterHint}>(match all)</span>
          <select aria-label="Filter entry tags" value="" onChange={event => { if (event.target.value) onTags([...new Set([...tags, event.target.value])]) }}>
            <option value="">Choose tag…</option>{summary?.tags.filter(item => !tags.includes(item.name)).map(item => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}
          </select>
        </label>
        <div className={styles.chips}>{tags.map(tag => <button type="button" key={tag} aria-label={`Clear tag filter ${tag}`} onClick={() => onTags(tags.filter(value => value !== tag))}>{tag} ×</button>)}</div>
        </div>
        <div className={styles.row}>
          {named && <><button type="button" disabled={busy || pending || needsReload} onClick={event => open('rename', event.currentTarget)}>Rename folder</button><button type="button" disabled={busy || pending || needsReload} onClick={event => open('move_folder', event.currentTarget)}>Move folder…</button><button type="button" disabled={busy || pending || needsReload} onClick={event => open('remove', event.currentTarget)}>Remove folder</button></>}
          {!hideSelectionActions && selectedIds.length > 0 && <><button type="button" disabled={busy || pending || needsReload} onClick={event => open('move', event.currentTarget)}>Move selected…</button><button type="button" disabled={busy || pending || needsReload} onClick={event => open('add_tags', event.currentTarget)}>Add tags…</button><button type="button" disabled={busy || pending || needsReload} onClick={event => open('remove_tags', event.currentTarget)}>Remove tags…</button></>}
        </div>
      </>}
    </div>
    {action && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }} onCancel={event => { event.preventDefault(); close() }}>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <h3 id={`${id}-title`}>{action === 'remove' ? 'Remove folder' : action === 'rename' ? 'Rename folder' : tagAction ? (action === 'add_tags' ? 'Add tag to selected entries' : 'Remove tag from selected entries') : 'Move entries'}</h3>
        {named && <p>Folder: {folder}</p>}
        {action === 'remove' && <p>Entries will remain in this lorebook and become Unfiled.</p>}
        {moveAction && <label>Destination lorebook<select aria-label="Destination lorebook" value={targetBook} disabled={pending} onChange={event => setTargetBook(event.target.value)}>{books.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>}
        {(moveAction || action === 'rename') && <><label>{action === 'rename' ? 'New folder name' : 'Destination folder'}<input aria-label={action === 'rename' ? 'New folder name' : 'Destination folder'} value={targetFolder} disabled={pending} placeholder="Unfiled" list={`${id}-destinations`} onChange={event => setTargetFolder(event.target.value)} /></label><datalist id={`${id}-destinations`}>{targetSummary?.folders.map(item => <option key={item.name} value={item.name} />)}</datalist>{moveAction && <p>Choose an existing folder, enter a new name, or leave blank for Unfiled. Tags and lore order are preserved.</p>}{action === 'rename' && <p>An existing name merges the two folders.</p>}</>}
        {tagAction && <label>Tag<input aria-label="Bulk tag" value={tagDraft} disabled={pending} onChange={event => setTagDraft(event.target.value)} /></label>}
        {error && <div role="alert" className={styles.error}>{error}{needsReload && <button type="button" disabled={pending} onClick={() => void reload()}>Reload entries</button>}</div>}
        <div className={styles.row}><button type="button" disabled={pending} onClick={close}>Cancel</button><button type="submit" disabled={pending || needsReload || (tagAction && !tagDraft.trim()) || (action === 'rename' && !targetFolder.trim())}>{pending ? 'Working…' : action === 'remove' ? 'Remove folder' : action === 'rename' ? 'Rename' : tagAction ? 'Apply tags' : 'Move'}</button></div>
      </form>
    </dialog>, document.body)}
  </>
}
