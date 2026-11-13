import { useId, useRef, useEffect, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { Check, ChevronRight, History, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styles from './FolderSection.module.css'

export function FolderNameEditor({ value, onChange, onSubmit, onCancel, disabled, submitLabel, placeholder }: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  disabled?: boolean
  submitLabel?: string
  placeholder?: string
}) {
  const { t } = useTranslation('shared', { keyPrefix: 'folderDropdown' })
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  return <div className={styles.folderRenameRow} onClick={event => event.stopPropagation()}>
    <input ref={inputRef} type="text" className={styles.folderRenameInput} value={value}
      aria-label={placeholder ?? t('folderNamePlaceholder')} placeholder={placeholder ?? t('folderNamePlaceholder')}
      disabled={disabled} onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      }} />
    <button type="button" className={styles.folderActionBtn} onClick={onSubmit}
      disabled={disabled || !value.trim()} aria-label={submitLabel ?? t('confirmRename')}><Check size={12} /></button>
    <button type="button" className={styles.folderActionBtn} onClick={onCancel}
      disabled={disabled} aria-label={t('cancelRename')}><X size={12} /></button>
  </div>
}

export interface FolderSectionProps {
  label: string
  count: number
  children?: ReactNode
  /** IDs of externally rendered rows when the caller keeps their identity stable. */
  controls?: string
  collapsed?: boolean
  keepMounted?: boolean
  onToggle?: () => void
  recent?: boolean
  hideHeader?: boolean
  /** A controlled rename form can temporarily replace the heading. */
  header?: ReactNode
  actions?: ReactNode
  dragHandle?: ReactNode
  headerDragProps?: ButtonHTMLAttributes<HTMLButtonElement>
}

/** Shared folder presentation; callers own selection, persistence and editing. */
export default function FolderSection({
  label, count, children, collapsed = false, onToggle, recent = false,
  hideHeader = false, header, actions, dragHandle, headerDragProps, controls, keepMounted = false,
}: FolderSectionProps) {
  const contentId = useId()
  const title = <><span className={styles.folderName}>{label}</span><span className={styles.folderCount}>{count}</span></>
  return (
    <div className={styles.folderGroup}>
      {!hideHeader && (recent ? (
        <div className={styles.recentHeader}><History size={12} />{title}</div>
      ) : (
        <div className={styles.folderHeaderRow}>
          {header ?? <>
            {dragHandle}
            <button type="button" className={styles.folderHeader} {...headerDragProps} onClick={onToggle}
              aria-expanded={!collapsed} aria-controls={controls ?? (children !== undefined ? contentId : undefined)}>
              <ChevronRight size={12} className={`${styles.folderChevron} ${!collapsed ? styles.folderChevronOpen : ''}`} />
              {title}
            </button>
            {actions}
          </>}
        </div>
      ))}
      {children !== undefined && (keepMounted || !collapsed) && <div id={contentId} hidden={collapsed}>{children}</div>}
    </div>
  )
}
