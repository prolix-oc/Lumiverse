import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { CheckSquare, Sparkles, Square } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import LazyImage from '@/components/shared/LazyImage'
import { charactersApi } from '@/api/characters'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { useStore } from '@/store'
import type { CharacterSummary, DecisionConnectionProfile } from '@/types/api'
import styles from './FolderOrganizeModal.module.css'

interface FolderOrganizeModalProps {
  characters: CharacterSummary[]
  /** Cards selected before opening — an empty selection selects everything. */
  initialSelectedIds: string[]
  folders: string[]
  onCreateFolder: (name: string) => void
  /** Moves cards and keeps the browser's local state in sync. */
  onBulkMove: (ids: string[], folder: string) => Promise<{ count: number }>
  onClose: () => void
}

/**
 * Multiselect cards and file them into folders by hand, or let a Decision model
 * with image input suggest a folder per card from its avatar. Suggestions only
 * stage the folder dropdowns — nothing moves until Apply.
 */
export default function FolderOrganizeModal({
  characters,
  initialSelectedIds,
  folders,
  onCreateFolder,
  onBulkMove,
  onClose,
}: FolderOrganizeModalProps) {
  const { t } = useTranslation('panels')
  const addToast = useStore((s) => s.addToast)
  const originalFolder = useMemo(
    () => Object.fromEntries(characters.map((card) => [card.id, card.folder])),
    [characters],
  )
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedIds.length ? initialSelectedIds : characters.map((card) => card.id)),
  )
  const [targets, setTargets] = useState<Record<string, string>>(() => ({ ...originalFolder }))
  const [connections, setConnections] = useState<DecisionConnectionProfile[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [busy, setBusy] = useState<'auto' | 'apply' | null>(null)
  const [newFolder, setNewFolder] = useState('')
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

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

  const selectedIds = useMemo(() => characters.filter((card) => selected.has(card.id)).map((card) => card.id), [characters, selected])
  const changedIds = useMemo(
    () => selectedIds.filter((id) => (targets[id] ?? '') !== (originalFolder[id] ?? '')),
    [selectedIds, targets, originalFolder],
  )
  const allSelected = characters.length > 0 && selectedIds.length === characters.length

  const toggleSelected = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreateFolder = () => {
    const name = newFolder.trim()
    if (!name) return
    onCreateFolder(name)
    setNewFolder('')
  }

  const handleAutoAssign = async () => {
    if (busy || selectedIds.length === 0 || folders.length === 0) return
    setBusy('auto')
    try {
      const result = await charactersApi.autoAssignFolders({
        ids: selectedIds,
        folders,
        ...(connectionId ? { connection_id: connectionId } : {}),
      })
      if (result.assignments.length > 0) {
        setTargets((previous) => {
          const next = { ...previous }
          for (const assignment of result.assignments) next[assignment.id] = assignment.folder
          return next
        })
        addToast({
          type: 'success',
          message: t('characterBrowser.organizeAutoDone', { count: result.assignments.length, model: result.model }),
        })
      }
      if (result.skipped.length > 0) {
        addToast({ type: 'info', message: t('characterBrowser.organizeAutoSkipped', { count: result.skipped.length }) })
      }
      if (result.assignments.length === 0 && result.skipped.length === 0) {
        addToast({ type: 'info', message: t('characterBrowser.organizeAutoDone', { count: 0, model: result.model }) })
      }
    } catch (err: any) {
      addToast({
        type: 'error',
        message: err?.body?.error || err?.message || t('characterBrowser.organizeAutoFailed'),
      })
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
      const results = await Promise.all([...groups].map(([folder, ids]) => onBulkMove(ids, folder)))
      const moved = results.reduce((total, result) => total + (result?.count || 0), 0)
      addToast({ type: 'success', message: t('characterBrowser.movedCharactersSuccess', { count: moved }) })
      onClose()
    } catch (err: any) {
      addToast({
        type: 'error',
        message: err?.body?.error || err?.message || t('characterBrowser.organizeApplyFailed'),
      })
    } finally {
      setBusy(null)
    }
  }

  if (characters.length === 0) {
    return createPortal(
      <div className={styles.overlay} onMouseDown={onClose}>
        <div className={styles.modal}>
          <div className={styles.header}>
            <h3 className={styles.title}>{t('characterBrowser.organizeTitle')}</h3>
            <CloseButton onClick={onClose} />
          </div>
          <p className={styles.hint}>{t('characterBrowser.organizeEmpty')}</p>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => { mouseDownTargetRef.current = event.target }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget
          && mouseDownTargetRef.current === event.currentTarget
          && !busy
        ) onClose()
      }}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>{t('characterBrowser.organizeTitle')}</h3>
          <CloseButton onClick={onClose} />
        </div>

        <p className={styles.hint}>{t('characterBrowser.organizeHint')}</p>

        <div className={styles.toolbar}>
          <span className={styles.count}>
            {t('characterBrowser.batchSelected', { selected: selectedIds.length, total: characters.length })}
          </span>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setSelected(allSelected ? new Set() : new Set(characters.map((card) => card.id)))}
            disabled={!!busy}
          >
            <CheckSquare size={13} />
            {allSelected ? t('characterBrowser.deselectAll') : t('characterBrowser.selectAll')}
          </button>
          <span className={styles.spacer} />
          <input
            className={styles.folderInput}
            value={newFolder}
            onChange={(event) => setNewFolder(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') handleCreateFolder() }}
            placeholder={t('characterBrowser.folderName')}
            maxLength={64}
            disabled={!!busy}
          />
          <button
            type="button"
            className={styles.linkBtn}
            onClick={handleCreateFolder}
            disabled={!!busy || !newFolder.trim()}
          >
            {t('characterBrowser.newFolder')}
          </button>
        </div>

        <div className={styles.list}>
          {characters.map((card) => {
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
                  value={targets[card.id] ?? ''}
                  onChange={(event) => {
                    const folder = event.target.value
                    setTargets((previous) => ({ ...previous, [card.id]: folder }))
                  }}
                  disabled={!isSelected || !!busy}
                  aria-label={`${t('characterBrowser.moveToFolder')}: ${card.name}`}
                >
                  <option value="">{t('characterBrowser.organizeNoFolder')}</option>
                  {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                </select>
              </div>
            )
          })}
        </div>

        <div className={styles.aiRow}>
          {connections.length > 0 && (
            <select
              className={styles.connectionSelect}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              disabled={busy === 'auto'}
              aria-label={t('characterBrowser.organizeConnection')}
            >
              {connections.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.is_default ? ` — ${t('characterBrowser.organizeDefaultConnection')}` : ''}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={styles.autoBtn}
            onClick={() => void handleAutoAssign()}
            disabled={!!busy || selectedIds.length === 0 || folders.length === 0 || (connections.length > 0 && !connectionId)}
            title={folders.length === 0 ? t('characterBrowser.organizeNeedsFolders') : undefined}
          >
            {busy === 'auto' ? <Spinner size={14} /> : <Sparkles size={14} />}
            {busy === 'auto' ? t('characterBrowser.organizeAutoBusy') : t('characterBrowser.organizeAutoAssign')}
          </button>
        </div>

        <div className={styles.actions}>
          <span className={styles.status}>
            {changedIds.length > 0
              ? t('characterBrowser.organizePending', { count: changedIds.length })
              : t('characterBrowser.organizeNoChanges')}
          </span>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={!!busy}>
            {t('characterBrowser.bulkTagsCancel')}
          </button>
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
      </div>
    </div>,
    document.body,
  )
}
