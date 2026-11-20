import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import clsx from 'clsx'
import styles from './CloseButton.module.css'

interface CloseButtonProps {
  onClick: () => void
  size?: 'sm' | 'md'
  variant?: 'subtle' | 'solid'
  position?: 'static' | 'absolute'
  iconSize?: number
  className?: string
  'data-part'?: string
}

export function CloseButton({
  onClick,
  size = 'md',
  variant = 'subtle',
  position = 'static',
  iconSize,
  className,
  'data-part': dataPart,
}: CloseButtonProps) {
  const { t: tc } = useTranslation('common')
  const resolvedIconSize = iconSize ?? (size === 'sm' ? 14 : 16)

  return (
    <button
      type="button"
      data-part={dataPart}
      onClick={onClick}
      aria-label={tc('actions.close')}
      className={clsx(
        styles.closeBtn,
        styles[size],
        styles[variant],
        position === 'absolute' && styles.absolute,
        className,
      )}
    >
      <X size={resolvedIconSize} />
    </button>
  )
}
