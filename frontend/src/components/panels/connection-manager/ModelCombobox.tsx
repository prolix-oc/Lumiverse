import { useState, useRef, useEffect, useCallback } from 'react'
import { RefreshCw, Loader } from 'lucide-react'
import { TextInput } from '@/components/shared/FormComponents'
import styles from './ModelCombobox.module.css'

interface ModelComboboxProps {
  value: string
  onChange: (value: string) => void
  models: string[]
  loading: boolean
  onRefresh?: () => void
  disabled?: boolean
  placeholder?: string
}

export default function ModelCombobox({ value, onChange, models, loading, onRefresh, disabled, placeholder }: ModelComboboxProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = models.filter((m) => m.toLowerCase().includes(value.toLowerCase()))

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSelect = useCallback((model: string) => {
    onChange(model)
    setOpen(false)
  }, [onChange])

  return (
    <div className={styles.combobox} ref={ref}>
      <div className={styles.inputRow}>
        <TextInput
          value={value}
          onChange={onChange}
          placeholder={placeholder || 'gpt-4o'}
          onFocus={() => models.length > 0 && setOpen(true)}
        />
        {onRefresh && (
          <button type="button" className={styles.refreshBtn} onClick={onRefresh} disabled={loading || disabled} title={disabled ? 'Save connection to fetch models' : 'Refresh models'}>
            {loading ? <Loader size={14} className={styles.spinner} /> : <RefreshCw size={14} />}
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className={styles.dropdown}>
          {filtered.map((model) => (
            <button key={model} type="button" className={styles.dropdownItem} onClick={() => handleSelect(model)}>
              {model}
            </button>
          ))}
        </div>
      )}
      {open && models.length > 0 && filtered.length === 0 && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownEmpty}>No matching models</div>
        </div>
      )}
    </div>
  )
}
