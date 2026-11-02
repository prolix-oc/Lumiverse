import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckSquare, FolderPlus, Pencil, Sparkles, Square, Trash2 } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import LazyImage from '@/components/shared/LazyImage'
import { charactersApi } from '@/api/characters'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { useFolders } from '@/hooks/useFolders'
import { useStore } from '@/store'
import type { Character, DecisionConnectionProfile } from '@/types/api'
import styles from './FoldersPanel.module.css'

/** Sentinel filter that shows every card regardless of folder. */
const ALL_FOLDERS = '*'
/** Folders page past this many cards would miss part of a large library. */
const MAX_LIBRARY_CARDS = 1000
const PAGE_SIZE = 100

/**
 * The Folders tab: file cards by hand or with a Decision model.
 *
 * The sidebar manages the folders themselves (create, rename, delete) — an
 * empty folder is stored so it survives until a card is filed into it. The
 * card list is a multiselect with a folder dropdown per card; "Suggest
 * folders with AI" asks a Decision model to sort the visible cards, and can
 * propose new folder names through an LLM connection. Nothing moves until
 * Apply.
 */
export default function FoldersPanel() {
  const { t } = useTranslation('panels')

  const [cards, setCards] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const { folders, createFolder, renameFolder: renameStoredFolder, deleteFolder: deleteStoredFolder } =
    useFolders('characterFolders', cards)

  const [filter, setFilter] = useState(ALL_FOLDERS)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [targets, setTargets] = useState<Record<string, string>>({})
  /** Folder names the model proposed that only exist once Apply runs. */
  const [suggestedFolders, setSuggestedFolders] = useState<string[]>([])
  const [newFolderName, setNewFolderName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [connections, setConnections] = useState<DecisionConnectionProfile[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [suggestNew, setSuggestNew] = useState(true)
  const [busy, setBusy] = useState<'ai' | 'apply' | 'rename' | 'delete' | null>(null)

  const refresh = useCallback(async () => {
    try {
      const collected: Character[] = []
      for (let offset = 0; offset < MAX_LIBRARY_CARDS; offset += PAGE_SIZE) {
        const page = await charactersApi.list({ limit: PAGE_SIZE, offset })
        collected.push(...(page.data || []))
        if (!page.data || page.data.length < PAGE_SIZE) break
      }
      collected.sort((a, b) => a.name.localeCompare(b.name))
      setCards(collected)
    } catch (err) {
      console.error('[Folders] Loading characters failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let cancelled = false
    decisionConnectionsApi
      .list({ limit: 100 })
      .then((page) => {
        if (cancelled) return
        const profiles = page.data || []
        setConnections(profiles)
        setConnectionId(profiles.find((profile) => profile.is_default)?.id || profiles[0]?.id || '')
      })
      .catch(() => { if (!cancelled) setConnections([]) })
    return () => { cancelled = true }
  }, [])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const card of cards) map.set(card.folder || '', (map.get(card.folder || '') ?? 0) + 1)
    return map
  }, [cards])

  const availableFolders = useMemo(
    () => [...folders, ...suggestedFolders.filter((folder) => !folders.includes(folder))],
    [folders, suggestedFolders],
  )

  const visibleCards = useMemo(
    () => (filter === ALL_FOLDERS ? cards : cards.filter((card) => (card.folder || '') === filter)),
    [cards, filter],
  )

  const originalFolder = useMemo(
    () => Object.fromEntries(cards.map((card) => [card.id, card.folder || ''])),
    [cards],
  )

  const selectedIds = useMemo(
    () => visibleCards.filter((card) => selected.has(card.id)).map((card) => card.id),
    [visibleCards, selected],
  )

  const changedIds = useMemo(
    () => visibleCards
      .filter((card) => selected.has(card.id) && (targets[card.id] ?? '') !== (originalFolder[card.id] ?? ''))
      .map((card) => card.id),
    [visibleCards, selected, targets, originalFolder],
  )

  const allVisibleSelected = visibleCards.length > 0 && selectedIds.length === visibleCards.length

  const toggleSelected = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreateFolder = () => {
    const name = newFolderName.trim()
    if (!name) return
    createFolder(name)
    setNewFolderName('')
    setFilter(name)
  }

  const handleRename = async (value?: string) => {
    if (!renaming) return
    const oldName = renaming
    const newName = (value ?? renameValue).trim()
    if (!newName || oldName === newName) {
      setRenaming(null)
      setRenameValue('')
      return
    }
    setBusy('rename')
    try {
      const result = await charactersApi.renameFolder(oldName, newName)
      renameStoredFolder(oldName, newName)
      setSuggestedFolders((previous) => previous.map((folder) => (folder === oldName ? newName : folder)))
      setFilter((previous) => (previous === oldName ? newName : previous))
      toast.success(t('characterBrowser.renamedFolderSuccess', { name: newName, count: result.count }))
      await refresh()
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.renameFolderFailed'))
    } finally {
      setBusy(null)
      setRenaming(null)
      setRenameValue('')
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    const name = deleting
    setBusy('delete')
    try {
      const result = await charactersApi.deleteFolder(name)
      deleteStoredFolder(name)
      setSuggestedFolders((previous) => previous.filter((folder) => folder !== name))
      setFilter((previous) => (previous === name ? ALL_FOLDERS : previous))
      toast.success(t('characterBrowser.deletedFolderSuccess', { name, count: result.count }))
      await refresh()
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.deleteFolderFailed'))
    } finally {
      setBusy(null)
      setDeleting(null)
    }
  }

  const handleAutoAssign = async () => {
    if (busy || visibleCards.length === 0) return
    setBusy('ai')
    try {
      const ids = selectedIds.length > 0 ? selectedIds : visibleCards.map((card) => card.id)
      const result = await charactersApi.autoAssignFolders({
        ids,
        folders,
        propose_new_folders: suggestNew,
        ...(connectionId ? { connection_id: connectionId } : {}),
      })
      if (result.newFolders.length > 0) setSuggestedFolders((previous) => [...previous, ...result.newFolders])
      if (result.assignments.length > 0) {
        setTargets((previous) => {
          const next = { ...previous }
          for (const assignment of result.assignments) next[assignment.id] = assignment.folder
          return next
        })
        toast.success(t('characterBrowser.organizeAutoDone', { count: result.assignments.length, model: result.model }))
      }
      if (result.newFolders.length > 0) {
        toast.info(t('characterBrowser.organizeAutoNewFolders', { count: result.newFolders.length }))
      }
      if (result.imagesSkipped) toast.info(t('characterBrowser.organizeAutoNoImages'))
      if (result.skipped.length > 0) {
        toast.info(t('characterBrowser.organizeAutoSkipped', { count: result.skipped.length }))
      }
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.organizeAutoFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleApply = async () => {
    if (busy || changedIds.length === 0) return
    setBusy('apply')
    try {
      const groups = new Map<string, string[]>()
      for (const id of changedIds) {
        const folder = targets[id] ?? ''
        const group = groups.get(folder)
        if (group) group.push(id)
        else groups.set(folder, [id])
      }
      const results = await Promise.all([...groups].map(([folder, ids]) => charactersApi.bulkUpdateFolder(ids, folder)))
      const moved = results.reduce((total, result) => total + (result?.count || 0), 0)
      // Folders the model proposed now exist because cards live in them.
      setSuggestedFolders([])
      setSelected(new Set())
      toast.success(t('characterBrowser.movedCharactersSuccess', { count: moved }))
      await refresh()
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.organizeApplyFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.panel}>
      <aside className={styles.sidebar}>
        <button
          type="button"
          className={`${styles.folderItem} ${filter === ALL_FOLDERS ? styles.folderItemActive : ''}`}
          onClick={() => setFilter(ALL_FOLDERS)}
        >
          <span className={styles.folderName}>{t('foldersPanel.allCards')}</span>
          <span className={styles.folderCount}>{cards.length}</span>
        </button>

        {folders.map((folder) => (
          <div key={folder} className={styles.folderRow}>
            <button
              type="button"
              className={`${styles.folderItem} ${filter === folder ? styles.folderItemActive : ''}`}
              onClick={() => setFilter(folder)}
            >
              <span className={styles.folderName}>{folder || t('characterBrowser.organizeNoFolder')}</span>
              <span className={styles.folderCount}>{counts.get(folder) ?? 0}</span>
            </button>
            <span className={styles.folderActions}>
              <button
                type="button"
                className={styles.iconBtn}
                title={t('characterBrowser.renameFolder', { name: folder })}
                onClick={() => { setRenaming(folder); setRenameValue(folder) }}
                disabled={!!busy}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                title={t('characterBrowser.deleteFolder', { name: folder })}
                onClick={() => setDeleting(folder)}
                disabled={!!busy}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}

        <div className={styles.newFolderRow}>
          <input
            className={styles.newFolderInput}
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') handleCreateFolder() }}
            placeholder={t('characterBrowser.folderName')}
            maxLength={64}
            disabled={!!busy}
          />
          <button
            type="button"
            className={styles.iconBtn}
            title={t('characterBrowser.newFolder')}
            onClick={handleCreateFolder}
            disabled={!!busy || !newFolderName.trim()}
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </aside>

      <section className={styles.main}>
        <div className={styles.aiRow}>
          {connections.length > 0 && (
            <select
              className={styles.connectionSelect}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              disabled={busy === 'ai'}
              aria-label={t('characterBrowser.organizeConnection')}
            >
              {connections.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.is_default ? ` — ${t('characterBrowser.organizeDefaultConnection')}` : ''}
                </option>
              ))}
            </select>
          )}
          <label className={styles.suggestToggle}>
            <input
              type="checkbox"
              checked={suggestNew}
              onChange={(event) => setSuggestNew(event.target.checked)}
              disabled={!!busy}
            />
            {t('characterBrowser.organizeSuggestNew')}
          </label>
          <button
            type="button"
            className={styles.autoBtn}
            onClick={() => void handleAutoAssign()}
            disabled={!!busy || visibleCards.length === 0 || (connections.length > 0 && !connectionId)}
          >
            {busy === 'ai' ? <Spinner size={14} /> : <Sparkles size={14} />}
            {busy === 'ai' ? t('characterBrowser.organizeAutoBusy') : t('characterBrowser.organizeAutoAssign')}
          </button>
        </div>

        <div className={styles.toolbar}>
          <span className={styles.count}>
            {t('characterBrowser.batchSelected', { selected: selectedIds.length, total: visibleCards.length })}
          </span>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleCards.map((card) => card.id)))}
            disabled={!!busy || visibleCards.length === 0}
          >
            {allVisibleSelected ? <CheckSquare size={13} /> : <Square size={13} />}
            {allVisibleSelected ? t('characterBrowser.deselectAll') : t('characterBrowser.selectAll')}
          </button>
          <span className={styles.spacer} />
          {filter !== ALL_FOLDERS && (
            <span className={styles.count}>{t('foldersPanel.cardCount', { count: counts.get(filter) ?? 0 })}</span>
          )}
        </div>

        <div className={styles.list}>
          {loading && (
            <div className={styles.empty}><Spinner size={16} /></div>
          )}
          {!loading && visibleCards.length === 0 && (
            <p className={styles.empty}>
              {cards.length === 0 ? t('foldersPanel.noCharacters') : t('foldersPanel.emptyFolder')}
            </p>
          )}
          {visibleCards.map((card) => {
            const isSelected = selected.has(card.id)
            const avatarUrl = getCharacterAvatarThumbUrl(card) ?? ''
            const tags = card.tags?.slice(0, 3) || []
            return (
              <div key={card.id} className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}>
                <button
                  type="button"
                  className={styles.check}
                  onClick={() => toggleSelected(card.id)}
                  disabled={!!busy}
                  aria-pressed={isSelected}
                  aria-label={card.name}
                >
                  {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                </button>
                <LazyImage
                  containerClassName={styles.thumb}
                  src={avatarUrl}
                  alt=""
                  spinnerSize={12}
                  fallback={<span className={styles.thumbFallback}>{card.name.slice(0, 1).toUpperCase()}</span>}
                />
                <span className={styles.meta}>
                  <span className={styles.name}>{card.name}</span>
                  {tags.length > 0 && <span className={styles.tags}>{tags.join(' · ')}</span>}
                </span>
                <select
                  className={styles.folderSelect}
                  value={targets[card.id] ?? card.folder ?? ''}
                  onChange={(event) => {
                    const folder = event.target.value
                    setTargets((previous) => ({ ...previous, [card.id]: folder }))
                  }}
                  disabled={!!busy}
                  aria-label={`${t('characterBrowser.moveToFolder')}: ${card.name}`}
                >
                  <option value="">{t('characterBrowser.organizeNoFolder')}</option>
                  {availableFolders.map((folder) => (
                    <option key={folder} value={folder}>
                      {suggestedFolders.includes(folder) && !folders.includes(folder)
                        ? t('characterBrowser.organizeNewFolderOption', { folder })
                        : folder}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className={styles.actions}>
          <span className={styles.status}>
            {changedIds.length > 0
              ? t('characterBrowser.organizePending', { count: changedIds.length })
              : t('characterBrowser.organizeNoChanges')}
          </span>
          <button
            type="button"
            className={styles.applyBtn}
            onClick={() => void handleApply()}
            disabled={!!busy || changedIds.length === 0}
          >
            {busy === 'apply' && <Spinner size={14} />}
            {t('characterBrowser.organizeApply')}
          </button>
        </div>
      </section>

      <ConfirmationModal
        isOpen={!!renaming}
        title={t('characterBrowser.renameFolder', { name: renaming ?? '' })}
        inputLabel={t('characterBrowser.folderName')}
        defaultInputValue={renameValue}
        confirmText={t('characterBrowser.organizeApply')}
        cancelText={t('common.actions.cancel')}
        loading={busy === 'rename'}
        onConfirm={(value) => void handleRename(value)}
        onCancel={() => { setRenaming(null); setRenameValue('') }}
      />

      <ConfirmationModal
        isOpen={!!deleting}
        variant="danger"
        title={t('characterBrowser.deleteFolderTitle')}
        message={t('characterBrowser.deleteFolderMessage', { name: deleting ?? '' })}
        confirmText={t('characterBrowser.delete')}
        cancelText={t('common.actions.cancel')}
        loading={busy === 'delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}
