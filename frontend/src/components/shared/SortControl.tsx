import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import clsx from 'clsx'
import styles from './SortControl.module.css'

export interface SortControlOption<T extends string> {
  value: T
  label: string
}

interface SortControlProps<T extends string> {
  options: readonly SortControlOption<T>[]
  value: T
  onChange: (value: T) => void
  title: string
  direction?: 'asc' | 'desc'
  onToggleDirection?: () => void
  ascendingTitle?: string
  descendingTitle?: string
  dropdownWidth?: number
  dropdownAlign?: 'start' | 'end'
}

/**
 * Compact sort menu used by the content browsers and other sortable lists.
 * Pass a direction callback for the paired ascending/descending control.
 */
export function SortControl<T extends string>({
  options,
  value,
  onChange,
  title,
  direction,
  onToggleDirection,
  ascendingTitle,
  descendingTitle,
  dropdownWidth,
  dropdownAlign = 'start',
}: SortControlProps<T>) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const openedAt = useRef(0)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const eventTime = event.timeStamp > 1_000_000_000_000
        ? event.timeStamp - performance.timeOrigin
        : event.timeStamp
      if (eventTime < openedAt.current + 100) return
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const toggleMenu = () => {
    if (!open) openedAt.current = performance.now()
    setOpen((current) => !current)
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={toggleMenu}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ArrowUpDown size={14} />
      </button>
      {open && (
        <div
          className={clsx(styles.dropdown, dropdownAlign === 'end' && styles.dropdownEnd)}
          role="menu"
          style={dropdownWidth ? { width: dropdownWidth } : undefined}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              className={clsx(styles.item, value === option.value && styles.itemActive)}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {onToggleDirection && direction && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleDirection}
          title={direction === 'asc' ? ascendingTitle : descendingTitle}
          aria-label={direction === 'asc' ? ascendingTitle : descendingTitle}
        >
          {direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
        </button>
      )}
    </div>
  )
}
