import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import clsx from 'clsx'
import { clearSearchOnEscape } from '@/lib/clearableSearch'
import styles from './SearchField.module.css'

interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  clearLabel: string
  className?: string
  actions?: ReactNode
}

/** Shared clearable search control for content browsers and feed toolbars. */
export default function SearchField({
  value,
  onChange,
  placeholder,
  clearLabel,
  className,
  actions,
}: SearchFieldProps) {
  return (
    <div className={clsx(styles.searchField, className)}>
      <Search size={14} className={styles.searchIcon} aria-hidden />
      <input
        type="search"
        className={styles.searchInput}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => clearSearchOnEscape(event, value, () => onChange(''))}
        placeholder={placeholder}
      />
      {value && (
        <button type="button" className={styles.clearButton} onClick={() => onChange('')} aria-label={clearLabel}>
          <X size={14} />
        </button>
      )}
      {actions}
    </div>
  )
}
