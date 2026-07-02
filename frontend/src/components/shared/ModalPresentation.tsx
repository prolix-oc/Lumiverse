import { type ReactNode } from 'react'
import clsx from 'clsx'
import { ModalShell } from './ModalShell'
import { CloseButton } from './CloseButton'
import styles from './ModalPresentation.module.css'

interface ModalPresentationProps {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  maxWidth?: string | number
  maxHeight?: string | number
  zIndex?: number
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  className?: string
  bodyClassName?: string
}

export function ModalPresentation({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidth = 'clamp(320px, 90vw, min(560px, var(--lumiverse-content-max-width, 560px)))',
  maxHeight = '85vh',
  zIndex,
  closeOnBackdrop = true,
  closeOnEscape = true,
  className,
  bodyClassName,
}: ModalPresentationProps) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      maxWidth={maxWidth}
      maxHeight={maxHeight}
      zIndex={zIndex}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEscape={closeOnEscape}
      className={className}
    >
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.title}>{title}</h3>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={clsx(styles.body, bodyClassName)}>
        {children}
      </div>

      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </ModalShell>
  )
}
