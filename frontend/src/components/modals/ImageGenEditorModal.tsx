import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { Button } from '@/components/shared/FormComponents'
import styles from './ImageGenEditorModal.module.css'
export function ImageGenEditorModal({ isOpen, onClose, title, children, navigation, dismissible = true }: {
  isOpen: boolean; onClose: () => void; title: string; children: ReactNode; navigation?: ReactNode; dismissible?: boolean
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => dialogRef.current?.focus())
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus() }
  }, [isOpen])
  return <ModalShell isOpen={isOpen} onClose={onClose} closeOnEscape={dismissible} closeOnBackdrop={dismissible} maxWidth={840} maxHeight="90dvh" modalId="image-gen-editor">
    <div className={styles.layout} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className={styles.header}><h2 id={titleId}>{title}</h2><button type="button" disabled={!dismissible} onClick={onClose} aria-label={`Close ${title}`}><X size={18} /></button></header>
      {navigation}
      <div className={styles.body}>{children}</div>
      <footer className={styles.footer}><Button variant="secondary" size="sm" disabled={!dismissible} onClick={onClose}>Done</Button></footer>
    </div>
  </ModalShell>
}
export function ImageGenViews<T extends string>({ value, onChange, views, label }: {
  value: T; onChange: (value: T) => void; views: Array<{ value: T; label: string }>; label: string
}) {
  return <nav className={styles.views} aria-label={label}>{views.map(view =>
    <button key={view.value} type="button" aria-pressed={value === view.value} onClick={() => onChange(view.value)}>{view.label}</button>
  )}</nav>
}
