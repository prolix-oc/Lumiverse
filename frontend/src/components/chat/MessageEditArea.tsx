import { Brain, ChevronRight, Maximize2 } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ExpandedTextEditor from '@/components/shared/ExpandedTextEditor'
import { useSpindleComponentOverride } from '@/lib/spindle/use-spindle-component-override'
import { readProductivityFeature } from '@/lib/spindle/productivity-feature-toggles'
import { useStore } from '@/store'
import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'
import styles from './MessageEditArea.module.css'

interface MessageEditAreaProps {
  editContent: string
  onChangeContent: (value: string) => void
  onSave: () => void
  onCancel: () => void
  onEditAndSend?: () => void
  messageId?: string
  editAndSendDisabled?: boolean
  editReasoning?: string
  onChangeReasoning?: (value: string) => void
}

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return
  const computed = window.getComputedStyle(el)
  const maxHeight = Number.parseFloat(computed.maxHeight)
  const { scrollTop, scrollLeft } = el
  // Measure the content at its natural height. Scrolling is deliberately
  // owned by CSS so this helper cannot strand a resized or viewport-clamped
  // editor with an inline `overflow-y: hidden` declaration.
  el.style.height = 'auto'
  const nextHeight = el.scrollHeight
  el.style.height = `${Number.isFinite(maxHeight) && maxHeight > 0 ? Math.min(nextHeight, maxHeight) : nextHeight}px`
  // The temporary natural height can clamp the native scroll position.
  // Keep the user's place; keyboard revealing follows the selection separately.
  el.scrollTop = scrollTop
  el.scrollLeft = scrollLeft
}

function MessageEditAreaNative({
  editContent, onChangeContent, onSave, onCancel,
  onEditAndSend, messageId, editAndSendDisabled,
  editReasoning, onChangeReasoning,
}: MessageEditAreaProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
  const { t: ts } = useTranslation('shared', { keyPrefix: 'expandedTextEditor' })
  const showEditAndSend = useStore((state) => readProductivityFeature(state, 'showEditAndSend'))
  const hasLumiverseSuite = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite'))
  const configuredEditAndSendSide = useStore((state) => state.quickToolbarSettings?.editAndSendSide)
  // Only an explicit left preference opts into the alternate order. Missing,
  // reset, invalid, and suite-unavailable values retain native right placement.
  const editAndSendSide = hasLumiverseSuite && configuredEditAndSendSide === 'left' ? 'left' : 'right'
  const hasReasoning = editReasoning != null && onChangeReasoning != null
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const reasoningRef = useRef<HTMLTextAreaElement>(null)
  const focusRequested = useStore((s) => s.messageEditDraft?.focusRequested === true)
  const consumeFocusRequest = useStore((s) => s.consumeMessageEditFocusRequest)
  const reasoningSectionId = useId()
  const [reasoningExpanded, setReasoningExpanded] = useState(false)
  // Which field (if any) is currently open in the full-screen editor.
  const [expandedField, setExpandedField] = useState<'content' | 'reasoning' | null>(null)
  // Cursor position captured at expand time so the modal opens where the caret was.
  const expandCursorRef = useRef<number | null>(null)

  // Fit to initial content on mount, and re-fit when the value changes externally.
  // useLayoutEffect prevents a paint frame at the wrong height.
  useLayoutEffect(() => {
    autoResize(contentRef.current)
  }, [editContent])
  useLayoutEffect(() => {
    autoResize(reasoningRef.current)
  }, [editReasoning, reasoningExpanded])

  useEffect(() => {
    setReasoningExpanded(false)
  }, [messageId])

  useLayoutEffect(() => {
    if (!focusRequested) return
    contentRef.current?.focus({ preventScroll: true })
    consumeFocusRequest()
  }, [consumeFocusRequest, focusRequested])

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
          <button
            type="button"
            className={`${styles.sectionLabel} ${styles.reasoningToggle}`}
            onClick={() => setReasoningExpanded((open) => !open)}
            aria-expanded={reasoningExpanded}
            aria-controls={reasoningSectionId}
            data-reasoning-toggle="true"
            title={t(reasoningExpanded ? 'messageEdit.collapseReasoning' : 'messageEdit.expandReasoning')}
          >
            <ChevronRight
              size={13}
              className={`${styles.reasoningChevron} ${reasoningExpanded ? styles.reasoningChevronOpen : ''}`}
            />
            <Brain size={13} />
            <span>{t('messageEdit.reasoning')}</span>
          </button>
          {reasoningExpanded && (
            <div id={reasoningSectionId} className={styles.reasoningEditor}>
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
      <div
        className={styles.editActions}
        data-edit-and-send-side={editAndSendSide}
        data-spindle-mount="message_edit_actions"
        data-spindle-scope-key={messageId ? `message:${messageId}:edit-actions` : undefined}
      >
        {editAndSendSide === 'left' && hasLumiverseSuite && showEditAndSend && Boolean(onEditAndSend) && (
          <button
            type="button"
            onClick={onEditAndSend}
            className={styles.editSaveBtn}
            data-edit-and-send-action="true"
            aria-label={t('messageEdit.editAndSend', { defaultValue: 'Edit and Send' })}
            disabled={editAndSendDisabled || !editContent.trim()}
          >
            {t('messageEdit.editAndSend', { defaultValue: 'Edit and Send' })}
          </button>
        )}
        <button type="button" onClick={onCancel} className={styles.editCancelBtn} disabled={editAndSendDisabled}>
          {tc('actions.cancel')}
        </button>
        <button type="button" onClick={onSave} className={styles.editSaveBtn} disabled={editAndSendDisabled}>
          {tc('actions.save')}
        </button>
        {editAndSendSide === 'right' && hasLumiverseSuite && showEditAndSend && Boolean(onEditAndSend) && (
          <button
            type="button"
            onClick={onEditAndSend}
            className={styles.editSaveBtn}
            data-edit-and-send-action="true"
            aria-label={t('messageEdit.editAndSend', { defaultValue: 'Edit and Send' })}
            disabled={editAndSendDisabled || !editContent.trim()}
          >
            {t('messageEdit.editAndSend', { defaultValue: 'Edit and Send' })}
          </button>
        )}
      </div>
      {expandedField === 'content' && (
        <ExpandedTextEditor
          value={editContent}
          onChange={onChangeContent}
          onClose={() => setExpandedField(null)}
          title={t('messageEdit.contentAria')}
          initialCursorPos={expandCursorRef.current}
          markdownOnly
          sourceRef={contentRef}
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
          sourceRef={reasoningRef}
        />
      )}
    </div>
  )
}

export default function MessageEditArea(props: MessageEditAreaProps) {
  return useSpindleComponentOverride('MessageEditArea', MessageEditAreaNative, props)
}
