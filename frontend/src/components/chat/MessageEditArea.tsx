import { Brain, Maximize2 } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ExpandedTextEditor from '@/components/shared/ExpandedTextEditor'
import styles from './MessageEditArea.module.css'

interface MessageEditAreaProps {
  editContent: string
  onChangeContent: (value: string) => void
  onSave: () => void
  onCancel: () => void
  editReasoning?: string
  onChangeReasoning?: (value: string) => void
}

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return
  const computed = window.getComputedStyle(el)
  const maxHeight = Number.parseFloat(computed.maxHeight)
  el.style.height = 'auto'
  const nextHeight = el.scrollHeight
  if (Number.isFinite(maxHeight) && maxHeight > 0) {
    el.style.height = `${Math.min(nextHeight, maxHeight)}px`
    el.style.overflowY = nextHeight > maxHeight ? 'auto' : 'hidden'
    return
  }
  el.style.height = `${nextHeight}px`
  el.style.overflowY = 'hidden'
}

function revealEditorInChatScroll(target: HTMLTextAreaElement | null) {
  if (!target || document.activeElement !== target || navigator.maxTouchPoints <= 0) return

  const container = target.closest<HTMLElement>('[data-chat-scroll="true"]')
  if (!container) return

  const targetRect = target.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const viewportBottom = window.visualViewport?.height ?? window.innerHeight
  const visibleTop = Math.max(containerRect.top, 0) + 12
  const visibleBottom = Math.min(containerRect.bottom, viewportBottom) - 18

  let delta = 0
  if (targetRect.bottom > visibleBottom) {
    delta = targetRect.bottom - visibleBottom
  } else if (targetRect.top < visibleTop) {
    delta = targetRect.top - visibleTop
  }

  if (Math.abs(delta) < 1) return
  container.scrollTop += delta
}

export default function MessageEditArea({
  editContent, onChangeContent, onSave, onCancel,
  editReasoning, onChangeReasoning,
}: MessageEditAreaProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
  const { t: ts } = useTranslation('shared', { keyPrefix: 'expandedTextEditor' })
  const hasReasoning = editReasoning != null && onChangeReasoning != null
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const reasoningRef = useRef<HTMLTextAreaElement>(null)
  // Which field (if any) is currently open in the full-screen editor.
  const [expandedField, setExpandedField] = useState<'content' | 'reasoning' | null>(null)
  // Cursor position captured at expand time so the modal opens where the caret was.
  const expandCursorRef = useRef<number | null>(null)

  // Fit to initial content on mount, and re-fit when the value changes externally.
  // useLayoutEffect prevents a paint frame at the wrong height.
  useLayoutEffect(() => {
    autoResize(contentRef.current)
    revealEditorInChatScroll(contentRef.current)
  }, [editContent])
  useLayoutEffect(() => {
    autoResize(reasoningRef.current)
    revealEditorInChatScroll(reasoningRef.current)
  }, [editReasoning])

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeContent(e.target.value)
  }, [onChangeContent])

  const handleReasoningChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeReasoning?.(e.target.value)
  }, [onChangeReasoning])

  const expandContent = useCallback(() => {
    expandCursorRef.current = contentRef.current?.selectionStart ?? null
    setExpandedField('content')
  }, [])

  const expandReasoning = useCallback(() => {
    expandCursorRef.current = reasoningRef.current?.selectionStart ?? null
    setExpandedField('reasoning')
  }, [])

  return (
    <div className={styles.editArea}>
      {hasReasoning && (
        <div className={styles.reasoningSection}>
          <div className={styles.sectionLabel}>
            <Brain size={13} />
            <span>{t('messageEdit.reasoning')}</span>
          </div>
          <div className={styles.textareaWrapper}>
            <textarea
              ref={reasoningRef}
              name="message-edit-reasoning"
              aria-label={t('messageEdit.reasoningAria')}
              className={`${styles.editTextarea} ${styles.reasoningTextarea}`}
              value={editReasoning}
              onChange={handleReasoningChange}
              placeholder={t('messageEdit.reasoningPlaceholder')}
            />
            <button
              type="button"
              className={styles.expandBtn}
              onClick={expandReasoning}
              title={ts('expandEditor')}
              aria-label={ts('expandEditor')}
            >
              <Maximize2 size={13} />
            </button>
          </div>
        </div>
      )}
      <div className={hasReasoning ? styles.contentSection : undefined}>
        {hasReasoning && (
          <div className={styles.sectionLabel}>
            <span>{t('messageEdit.response')}</span>
          </div>
        )}
        <div className={styles.textareaWrapper}>
          <textarea
            ref={contentRef}
            name="message-edit-content"
            aria-label={t('messageEdit.contentAria')}
            className={styles.editTextarea}
            value={editContent}
            onChange={handleContentChange}
            autoFocus
          />
          <button
            type="button"
            className={styles.expandBtn}
            onClick={expandContent}
            title={ts('expandEditor')}
            aria-label={ts('expandEditor')}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      <div className={styles.editActions}>
        <button type="button" onClick={onCancel} className={styles.editCancelBtn}>
          {tc('actions.cancel')}
        </button>
        <button type="button" onClick={onSave} className={styles.editSaveBtn}>
          {tc('actions.save')}
        </button>
      </div>
      {expandedField === 'content' && (
        <ExpandedTextEditor
          value={editContent}
          onChange={onChangeContent}
          onClose={() => setExpandedField(null)}
          title={t('messageEdit.contentAria')}
          initialCursorPos={expandCursorRef.current}
          markdownOnly
        />
      )}
      {expandedField === 'reasoning' && hasReasoning && (
        <ExpandedTextEditor
          value={editReasoning ?? ''}
          onChange={onChangeReasoning ?? (() => {})}
          onClose={() => setExpandedField(null)}
          title={t('messageEdit.reasoningAria')}
          placeholder={t('messageEdit.reasoningPlaceholder')}
          initialCursorPos={expandCursorRef.current}
          markdownOnly
        />
      )}
    </div>
  )
}
