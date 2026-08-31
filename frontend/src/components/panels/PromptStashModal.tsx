import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Search, Trash2 } from 'lucide-react'
import { presetsApi, type StashedPromptBlock } from '@/api/presets'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import styles from './PromptStashModal.module.css'
import { applyPresetAuthorityResult, presetSaveCoordinator } from '@/lib/loom/preset-save-coordinator'

interface PromptStashModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (entry: StashedPromptBlock) => void
}

export function PromptStashModal({ isOpen, onClose, onSelect }: PromptStashModalProps) {
  const [entries, setEntries] = useState<StashedPromptBlock[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setIsLoading(true)
    setError(null)
    presetsApi.listStash()
      .then((stash) => { if (!cancelled) setEntries(stash) })
      .catch(() => { if (!cancelled) setError('Unable to load the prompt stash.') })
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [isOpen])

  const shown = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return normalizedQuery
      ? entries.filter((entry) => `${entry.block.name}\n${entry.block.content}\n${entry.sourcePreset?.name ?? ''}`.toLowerCase().includes(normalizedQuery))
      : entries
  }, [entries, query])

  const select = useCallback((entry: StashedPromptBlock) => {
    onSelect(entry)
    onClose()
  }, [onClose, onSelect])

  const unStash = useCallback(async (entry: StashedPromptBlock) => {
    setRemovingId(entry.id)
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    try {
      const result = await presetsApi.removeFromStash(entry.id)
      applyPresetAuthorityResult(result, scopeEpoch, (draft) => ({
        ...draft,
        blocks: draft.blocks.map((block) => {
          if (block.stashId !== entry.id) return block
          const { stashId: _stashId, ...unlinked } = block
          return unlinked
        }),
      }))
      if (presetSaveCoordinator.getScopeEpoch() !== scopeEpoch) return
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))
    } catch {
      setError('Unable to un-stash this prompt block.')
    } finally {
      setRemovingId(null)
    }
  }, [])

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={620} className={styles.modal}>
      <div className={styles.header}>
        <div className={styles.headerIcon}><Archive size={19} /></div>
        <div className={styles.headerText}>
          <h2 className={styles.title}>Prompt stash</h2>
          <p className={styles.subtitle}>Add a shared prompt block to this preset.</p>
        </div>
        <CloseButton onClick={onClose} iconSize={19} />
      </div>

      <div className={styles.controls}>
        <div className={styles.searchBox}>
          <Search size={15} />
          <input
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search stashed prompts…"
            autoFocus
          />
        </div>
      </div>

      <div className={styles.entries}>
        {isLoading && <div className={styles.status}>Loading stash…</div>}
        {error && <div className={styles.error}>{error}</div>}
        {!isLoading && !error && shown.length === 0 && (
          <div className={styles.empty}>
            <Archive size={22} />
            <div>{entries.length === 0 ? 'Your prompt stash is empty.' : 'No stashed prompts match your search.'}</div>
          </div>
        )}
        {shown.map((entry) => (
          <div className={styles.entry} key={entry.id}>
            <button className={styles.entrySelect} type="button" onClick={() => select(entry)}>
              <span className={styles.entryName}>{entry.block.name}</span>
              <span className={styles.entryPreview}>{entry.block.content || 'Empty prompt block'}</span>
              <span className={styles.entrySource}>From {entry.sourcePreset?.name ?? 'an unknown preset'}</span>
            </button>
            <button
              className={styles.unStashButton}
              type="button"
              onClick={() => void unStash(entry)}
              disabled={removingId === entry.id}
              title="Un-stash this prompt block"
            >
              <Trash2 size={13} />
              {removingId === entry.id ? 'Un-stashing…' : 'Un-stash'}
            </button>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}
