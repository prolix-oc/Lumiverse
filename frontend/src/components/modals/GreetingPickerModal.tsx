import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Check } from 'lucide-react'
import type { Character } from '@/types/api'
import styles from './GreetingPickerModal.module.css'
import clsx from 'clsx'

interface GreetingPickerModalProps {
  character: Character
  activeContent?: string
  onSelect: (greetingIndex: number) => void
  onCancel: () => void
}

export default function GreetingPickerModal({
  character,
  activeContent,
  onSelect,
  onCancel,
}: GreetingPickerModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [onCancel])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel()
    },
    [onCancel]
  )

  const greetings = [
    { label: 'Default Greeting', content: character.first_mes },
    ...(character.alternate_greetings || []).map((g, i) => ({
      label: `Greeting #${i + 2}`,
      content: g,
    })),
  ]

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <button
            onClick={onCancel}
            type="button"
            className={styles.closeBtn}
            aria-label="Close"
          >
            <X size={16} />
          </button>

          <div className={styles.header}>
            <h3 className={styles.title}>Choose a Greeting</h3>
            <span className={styles.count}>{greetings.length} greetings</span>
          </div>

          <div className={styles.list}>
            {greetings.map((g, i) => {
              const isActive = activeContent !== undefined && g.content === activeContent
              return (
                <button
                  key={i}
                  type="button"
                  className={clsx(styles.card, isActive && styles.cardActive)}
                  onClick={() => onSelect(i)}
                  style={{ animationDelay: `${Math.min(i * 40, 200)}ms` }}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.cardLabel}>{g.label}</span>
                    {isActive && (
                      <span className={styles.activeBadge}>
                        <Check size={10} />
                        Active
                      </span>
                    )}
                  </div>
                  <div className={styles.cardPreview}>{g.content}</div>
                </button>
              )
            })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
