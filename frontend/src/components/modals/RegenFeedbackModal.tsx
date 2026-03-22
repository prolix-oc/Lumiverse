import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { MessageSquareText } from 'lucide-react'
import styles from './RegenFeedbackModal.module.css'
import clsx from 'clsx'

interface RegenFeedbackModalProps {
  onSubmit: (feedback: string) => void
  onSkip: () => void
  onCancel: () => void
}

export default function RegenFeedbackModal({
  onSubmit,
  onSkip,
  onCancel,
}: RegenFeedbackModalProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    // Auto-focus textarea
    requestAnimationFrame(() => textareaRef.current?.focus())
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

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed) onSubmit(trimmed)
  }, [text, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

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
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.header}>
            <MessageSquareText size={16} />
            <h3 className={styles.title}>Regeneration Feedback</h3>
          </div>

          <p className={styles.subtitle}>
            Provide guidance for the next generation. This will be included as an OOC instruction.
          </p>

          <div className={styles.body}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Make the response shorter, focus on dialogue, change the tone to be more playful..."
              rows={4}
            />

            <div className={styles.actions}>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnCancel)}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnSkip)}
                onClick={onSkip}
              >
                Skip
              </button>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnSubmit)}
                onClick={handleSubmit}
                disabled={!text.trim()}
              >
                Regenerate
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
