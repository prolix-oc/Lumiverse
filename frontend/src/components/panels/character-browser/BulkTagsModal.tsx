import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { X, Plus } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { CloseButton } from '@/components/shared/CloseButton'
import { charactersApi } from '@/api/characters'
import { useStore } from '@/store'
import type { TagCount } from '@/types/api'
import styles from './BulkTagsModal.module.css'

type Operation = 'add' | 'remove' | 'replace'

interface BulkTagsModalProps {
  isOpen: boolean
  selectedIds: string[]
  allTags: TagCount[]
  onClose: () => void
  onApplied: () => void
}

export default function BulkTagsModal({ isOpen, selectedIds, allTags, onClose, onApplied }: BulkTagsModalProps) {
  const { t } = useTranslation('panels')
  const addToast = useStore((s) => s.addToast)
  const [operation, setOperation] = useState<Operation>('add')
  const [staged, setStaged] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [applying, setApplying] = useState(false)
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  if (!isOpen) return null

  const opLabelKey = (op: Operation) => `characterBrowser.bulkTags${op.charAt(0).toUpperCase()}${op.slice(1)}`
  const opHintKey = (op: Operation) => `${opLabelKey(op)}Hint`

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (!tag || staged.includes(tag)) return
    setStaged([...staged, tag])
    setDraft('')
  }
  const removeTag = (tag: string) => setStaged((prev) => prev.filter((t) => t !== tag))

  const handleApply = async () => {
    if (staged.length === 0 || selectedIds.length === 0 || applying) return
    setApplying(true)
    try {
      const result = await charactersApi.bulkUpdateTags(selectedIds, operation, staged)
      if (result.updated > 0) {
        addToast({ type: 'success', message: t('characterBrowser.bulkTagsApplied', { count: result.updated }) })
        setStaged([])
        setDraft('')
        setOperation('add')
        onApplied()
      } else {
        const zeroKey = operation === 'add'
          ? 'characterBrowser.bulkTagsAlreadyPresent'
          : operation === 'remove'
            ? 'characterBrowser.bulkTagsNoneToRemove'
            : 'characterBrowser.bulkTagsNoChange'
        addToast({ type: 'info', message: t(zeroKey, { count: selectedIds.length }) })
      }
    } catch (err) {
      let message: string | undefined
      if (err && typeof err === 'object' && 'body' in err) {
        const body = err.body
        if (body && typeof body === 'object' && 'error' in body) {
          const error = body.error
          message = typeof error === 'string' ? error : undefined
        }
      }
      addToast({ type: 'error', message: message || t('characterBrowser.bulkTagsFailed') })
    } finally {
      setApplying(false)
    }
  }

  const operations: Operation[] = ['add', 'remove', 'replace']
  const suggestions = allTags.map((tag) => tag.tag).filter((tag) => !staged.includes(tag)).slice(0, 20)

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
      onClick={(e) => e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget && !applying && onClose()}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>{t('characterBrowser.bulkTagsTitle')}</h3>
          <CloseButton onClick={onClose} />
        </div>
        <div className={styles.body}>
          <p className={styles.count}>{t('characterBrowser.bulkTagsCount', { count: selectedIds.length })}</p>
          <div className={styles.segmented}>
            {operations.map((op) => (
              <button
                key={op}
                type="button"
                className={`${styles.segBtn} ${operation === op ? styles.segBtnActive : ''}`}
                onClick={() => setOperation(op)}
                disabled={applying}
              >
                {t(opLabelKey(op))}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{t(opHintKey(operation))}</p>
          <div className={styles.tagInputRow}>
            <input
              className={styles.tagInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag(draft)}
              placeholder={t('characterBrowser.bulkTagsPlaceholder')}
              disabled={applying}
              autoFocus
            />
            <button type="button" className={styles.tagAddBtn} onClick={() => addTag(draft)} disabled={!draft.trim() || applying}>
              <Plus size={14} />
            </button>
          </div>
          {staged.length > 0 && (
            <div className={styles.stagedTags}>
              {staged.map((tag) => (
                <span key={tag} className={styles.tagChip}>
                  {tag}
                  <button type="button" className={styles.tagRemove} onClick={() => removeTag(tag)} disabled={applying}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {suggestions.length > 0 && (
            <div className={styles.suggestions}>
              <span className={styles.suggestionsLabel}>{t('characterBrowser.bulkTagsSuggestions')}</span>
              <div className={styles.suggestionChips}>
                {suggestions.map((tag) => (
                  <button key={tag} type="button" className={styles.suggestionChip} onClick={() => addTag(tag)} disabled={applying}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={applying}>
            {t('characterBrowser.bulkTagsCancel')}
          </button>
          <button
            type="button"
            className={styles.applyBtn}
            onClick={handleApply}
            disabled={staged.length === 0 || selectedIds.length === 0 || applying}
          >
            {applying ? <Spinner size={14} /> : null}
            {t('characterBrowser.bulkTagsApply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
