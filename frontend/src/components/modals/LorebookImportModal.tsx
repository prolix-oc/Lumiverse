import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import { worldBooksApi } from '@/api/world-books'
import type { LorebookInfo } from './BulkImportProgressModal'
import styles from './LorebookImportModal.module.css'

interface LorebookImportModalProps {
  isOpen: boolean
  lorebooks: LorebookInfo[]
  onClose: () => void
}

export default function LorebookImportModal({
  isOpen,
  lorebooks,
  onClose,
}: LorebookImportModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  // Reset selections when lorebooks change (select all by default)
  useEffect(() => {
    setSelected(new Set(lorebooks.map((l) => l.characterId)))
  }, [lorebooks])

  const allSelected = selected.size === lorebooks.length
  const noneSelected = selected.size === 0

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(lorebooks.map((l) => l.characterId)))
    }
  }, [allSelected, lorebooks])

  const toggle = useCallback((characterId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(characterId)) {
        next.delete(characterId)
      } else {
        next.add(characterId)
      }
      return next
    })
  }, [])

  const handleImport = useCallback(async () => {
    if (noneSelected) return
    setImporting(true)
    try {
      const toImport = lorebooks.filter((l) => selected.has(l.characterId))
      await Promise.allSettled(
        toImport.map((l) => worldBooksApi.importCharacterBook(l.characterId))
      )
    } finally {
      setImporting(false)
      onClose()
    }
  }, [lorebooks, selected, noneSelected, onClose])

  return createPortal(
    <AnimatePresence>
      {isOpen && lorebooks.length > 0 && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className={styles.header}>
              <div className={styles.headerLeft}>
                <span className={styles.title}>Embedded Lorebooks</span>
                <span className={styles.badge}>{lorebooks.length}</span>
              </div>
              <button type="button" className={styles.closeBtn} onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className={styles.body}>
              <label className={styles.selectAll}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                />
                Select All
              </label>

              <div className={styles.lorebookList}>
                {lorebooks.map((lb) => (
                  <label key={lb.characterId} className={styles.lorebookItem}>
                    <input
                      type="checkbox"
                      checked={selected.has(lb.characterId)}
                      onChange={() => toggle(lb.characterId)}
                    />
                    <div className={styles.lorebookInfo}>
                      <span className={styles.lorebookName}>{lb.lorebookName}</span>
                      <span className={styles.lorebookMeta}>from {lb.characterName}</span>
                    </div>
                    <span className={styles.entryBadge}>
                      {lb.entryCount} {lb.entryCount === 1 ? 'entry' : 'entries'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.footer}>
              <button type="button" className={styles.skipBtn} onClick={onClose}>
                Skip
              </button>
              <button
                type="button"
                className={styles.importBtn}
                disabled={noneSelected || importing}
                onClick={handleImport}
              >
                {importing
                  ? 'Importing...'
                  : allSelected
                    ? 'Import All'
                    : `Import ${selected.size} Selected`}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
