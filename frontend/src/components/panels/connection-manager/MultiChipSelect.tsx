import { useState, useRef, useEffect } from 'react'
import { X, ChevronDown } from 'lucide-react'
import styles from './MultiChipSelect.module.css'

interface Option {
  value: string
  label: string
}

interface MultiChipSelectProps {
  options: Option[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  loading?: boolean
}

export default function MultiChipSelect({ options, selected, onChange, placeholder, loading }: MultiChipSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const available = options.filter((o) => !selected.includes(o.value))
  const filtered = search
    ? available.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()) || o.value.toLowerCase().includes(search.toLowerCase()))
    : available

  const handleAdd = (value: string) => {
    onChange([...selected, value])
    setSearch('')
  }

  const handleRemove = (value: string) => {
    onChange(selected.filter((s) => s !== value))
  }

  const getLabel = (value: string) => options.find((o) => o.value === value)?.label || value

  return (
    <div className={styles.container} ref={ref}>
      <div className={styles.chipArea} onClick={() => setOpen(true)}>
        {selected.map((value) => (
          <span key={value} className={styles.chip}>
            <span className={styles.chipLabel}>{getLabel(value)}</span>
            <button
              type="button"
              className={styles.chipRemove}
              onClick={(e) => { e.stopPropagation(); handleRemove(value) }}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          className={styles.searchInput}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? (placeholder || 'Select...') : ''}
        />
        <ChevronDown size={12} className={styles.chevron} />
      </div>
      {open && (
        <div className={styles.dropdown}>
          {loading && <div className={styles.dropdownEmpty}>Loading...</div>}
          {!loading && filtered.length === 0 && (
            <div className={styles.dropdownEmpty}>
              {available.length === 0 ? 'All selected' : 'No matches'}
            </div>
          )}
          {!loading && filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              className={styles.dropdownItem}
              onClick={() => handleAdd(o.value)}
            >
              <span className={styles.dropdownLabel}>{o.label}</span>
              <span className={styles.dropdownSlug}>{o.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
