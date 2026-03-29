import { useState, useRef, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { TextInput } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import styles from './ModelCombobox.module.css'

interface ModelComboboxProps {
  value: string
  onChange: (value: string) => void
  models: string[]
  /** Optional map of model ID → human-readable label. */
  modelLabels?: Record<string, string>
  loading: boolean
  onRefresh?: () => void
  disabled?: boolean
  placeholder?: string
}

export default function ModelCombobox({ value, onChange, models, modelLabels, loading, onRefresh, disabled, placeholder }: ModelComboboxProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const hasLabels = modelLabels && Object.keys(modelLabels).length > 0

  const filtered = models.filter((m) => {
    const q = value.toLowerCase()
    if (m.toLowerCase().includes(q)) return true
    if (hasLabels && modelLabels[m]?.toLowerCase().includes(q)) return true
    return false
  })

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
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className={styles.dropdown}>
          {filtered.map((model) => (
            <button key={model} type="button" className={styles.dropdownItem} onClick={() => handleSelect(model)}>
              {hasLabels && modelLabels[model] ? (
                <>
                  <span className={styles.modelLabel}>{modelLabels[model]}</span>
                  <span className={styles.modelId}>{model}</span>
                </>
              ) : (
                model
              )}
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
