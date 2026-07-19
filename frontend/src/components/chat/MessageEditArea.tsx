import { Brain, Maximize2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
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

const EDITOR_VISIBLE_TOP_GUTTER = 12
const EDITOR_KEYBOARD_GUTTER = 72
const EDITOR_REVEAL_THRESHOLD = 12
const EDITOR_MIN_MOBILE_HEIGHT = 140

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return
  const computed = window.getComputedStyle(el)
  let maxHeight = Number.parseFloat(computed.maxHeight)
  if (navigator.maxTouchPoints > 0 && document.activeElement === el) {
    const viewportBottom = window.visualViewport?.height ?? window.innerHeight
    const top = el.getBoundingClientRect().top
    const availableHeight = Math.max(EDITOR_MIN_MOBILE_HEIGHT, viewportBottom - top - EDITOR_KEYBOARD_GUTTER)
    maxHeight = Number.isFinite(maxHeight) && maxHeight > 0
      ? Math.min(maxHeight, availableHeight)
      : availableHeight
  }
  const nextHeight = el.scrollHeight
  if (Number.isFinite(maxHeight) && maxHeight > 0) {
    el.style.height = `${Math.min(nextHeight, maxHeight)}px`
    el.style.overflowY = nextHeight > maxHeight ? 'auto' : 'hidden'
    return
  }
  el.style.height = `${nextHeight}px`
  el.style.overflowY = 'hidden'
}

function getEditorOcclusion(target: HTMLTextAreaElement | null) {
  if (!target || document.activeElement !== target || navigator.maxTouchPoints <= 0) return null
  const container = target.closest<HTMLElement>('[data-chat-scroll="true"]')
  if (!container) return null

  const targetRect = target.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const viewportBottom = window.visualViewport?.height ?? window.innerHeight
  const visibleTop = Math.max(containerRect.top, 0) + EDITOR_VISIBLE_TOP_GUTTER
  const visibleBottom = Math.min(containerRect.bottom, viewportBottom) - EDITOR_KEYBOARD_GUTTER

  let delta = 0
  if (targetRect.bottom > visibleBottom) {
    delta = targetRect.bottom - visibleBottom
  } else if (targetRect.top < visibleTop) {
    delta = targetRect.top - visibleTop
  }

  return { container, delta }
}

function syncEditorVisibility(target: HTMLTextAreaElement | null, correctedRef: MutableRefObject<boolean>) {
  if (correctedRef.current) return
  const occlusion = getEditorOcclusion(target)
  if (!occlusion) return

  const isOccluded = Math.abs(occlusion.delta) >= EDITOR_REVEAL_THRESHOLD
  if (isOccluded) {
    occlusion.container.scrollTop += occlusion.delta
    correctedRef.current = true
  }
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
  const contentRevealFrameRef = useRef(0)
  const reasoningRevealFrameRef = useRef(0)
  const focusCorrectionTimersRef = useRef<number[]>([])
  const contentCorrectedForFocusRef = useRef(false)
  const reasoningCorrectedForFocusRef = useRef(false)
  // Which field (if any) is currently open in the full-screen editor.
  const [expandedField, setExpandedField] = useState<'content' | 'reasoning' | null>(null)
  // Cursor position captured at expand time so the modal opens where the caret was.
  const expandCursorRef = useRef<number | null>(null)

  const scheduleEditorVisibilitySync = useCallback((
    targetRef: RefObject<HTMLTextAreaElement>,
    correctedRef: MutableRefObject<boolean>,
    frameRef: MutableRefObject<number>,
  ) => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      syncEditorVisibility(targetRef.current, correctedRef)
    })
  }, [])

  const clearFocusCorrectionTimers = useCallback(() => {
    for (const timer of focusCorrectionTimersRef.current) {
      window.clearTimeout(timer)
    }
    focusCorrectionTimersRef.current = []
  }, [])

  // Fit to initial content on mount, and re-fit when the value changes externally.
  // useLayoutEffect prevents a paint frame at the wrong height.
  useLayoutEffect(() => {
    autoResize(contentRef.current)
  }, [editContent])
  useLayoutEffect(() => {
    autoResize(reasoningRef.current)
  }, [editReasoning])

  useEffect(() => {
    if (navigator.maxTouchPoints <= 0) return

    const syncFocusedEditor = () => {
      scheduleEditorVisibilitySync(contentRef, contentCorrectedForFocusRef, contentRevealFrameRef)
      scheduleEditorVisibilitySync(reasoningRef, reasoningCorrectedForFocusRef, reasoningRevealFrameRef)
    }

    const viewport = window.visualViewport
    viewport?.addEventListener('resize', syncFocusedEditor)
    viewport?.addEventListener('scroll', syncFocusedEditor)

    return () => {
      viewport?.removeEventListener('resize', syncFocusedEditor)
      viewport?.removeEventListener('scroll', syncFocusedEditor)
    }
  }, [scheduleEditorVisibilitySync])

  useEffect(() => () => {
    cancelAnimationFrame(contentRevealFrameRef.current)
    cancelAnimationFrame(reasoningRevealFrameRef.current)
    clearFocusCorrectionTimers()
  }, [clearFocusCorrectionTimers])

  const scheduleFocusCorrection = useCallback((
    targetRef: RefObject<HTMLTextAreaElement>,
    correctedRef: MutableRefObject<boolean>,
    frameRef: MutableRefObject<number>,
  ) => {
    clearFocusCorrectionTimers()
    correctedRef.current = false
    scheduleEditorVisibilitySync(targetRef, correctedRef, frameRef)
    focusCorrectionTimersRef.current = [
      window.setTimeout(() => scheduleEditorVisibilitySync(targetRef, correctedRef, frameRef), 180),
      window.setTimeout(() => scheduleEditorVisibilitySync(targetRef, correctedRef, frameRef), 360),
    ]
  }, [clearFocusCorrectionTimers, scheduleEditorVisibilitySync])

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

  const handleContentFocus = useCallback(() => {
    scheduleFocusCorrection(contentRef, contentCorrectedForFocusRef, contentRevealFrameRef)
  }, [scheduleFocusCorrection])

  const handleReasoningFocus = useCallback(() => {
    scheduleFocusCorrection(reasoningRef, reasoningCorrectedForFocusRef, reasoningRevealFrameRef)
  }, [scheduleFocusCorrection])

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
              onFocus={handleReasoningFocus}
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
            onFocus={handleContentFocus}
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
