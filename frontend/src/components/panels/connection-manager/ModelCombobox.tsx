import { useState, useRef, useEffect, useCallback } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Search } from 'lucide-react'
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
  autoRefreshOnFocus?: boolean
  refreshKey?: string
  emptyMessage?: string
  loadingMessage?: string
  browseHint?: string
  appearance?: 'compact' | 'standard' | 'editor'
}

export default function ModelCombobox({
  value,
  onChange,
  models,
  modelLabels,
  loading,
  onRefresh,
  disabled,
  placeholder,
  autoRefreshOnFocus = false,
  refreshKey,
  emptyMessage: emptyMessageProp,
  loadingMessage: loadingMessageProp,
  browseHint,
  appearance = 'compact',
}: ModelComboboxProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'modelCombobox' })
  const emptyMessage = emptyMessageProp ?? t('emptyDefault')
  const loadingMessage = loadingMessageProp ?? t('loading')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const autoRefreshedRef = useRef(false)
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

  useEffect(() => {
    autoRefreshedRef.current = false
  }, [refreshKey])

  const handleSelect = useCallback((model: string) => {
    onChange(model)
    setOpen(false)
  }, [onChange])

  const handleFocus = useCallback(() => {
    if (disabled) return
    setOpen(true)
    if (autoRefreshOnFocus && onRefresh && !autoRefreshedRef.current && models.length === 0) {
      autoRefreshedRef.current = true
      onRefresh()
    }
  }, [autoRefreshOnFocus, disabled, models.length, onRefresh])

  const handleRefresh = useCallback(() => {
    if (!onRefresh) return
    autoRefreshedRef.current = true
    setOpen(true)
    onRefresh()
  }, [onRefresh])

  const shouldShowDropdown = open && (loading || models.length > 0 || (autoRefreshOnFocus && !!onRefresh))

  return (
    <div
      className={clsx(
        styles.combobox,
        appearance === 'editor'
          ? styles.comboboxEditor
          : appearance === 'standard'
            ? styles.comboboxStandard
            : styles.comboboxCompact,
      )}
      ref={ref}
    >
      <div className={styles.inputRow}>
        <TextInput
          value={value}
          onChange={onChange}
          placeholder={placeholder || 'gpt-4o'}
          onFocus={handleFocus}
          disabled={disabled}
          className={clsx(styles.input, appearance === 'editor' && styles.inputEditor)}
        />
        {onRefresh && (
          <button
            type="button"
            className={clsx(styles.refreshBtn, appearance === 'editor' && styles.refreshBtnEditor)}
            onClick={handleRefresh}
            disabled={loading || disabled}
            title={t('refreshModels')}
          >
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          </button>
        )}
      </div>
      {shouldShowDropdown && loading && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownEmpty}>{loadingMessage}</div>
        </div>
      )}
      {shouldShowDropdown && !loading && filtered.length > 0 && (
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
      {shouldShowDropdown && !loading && models.length > 0 && filtered.length === 0 && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownEmpty}>{t('noMatching')}</div>
        </div>
      )}
      {shouldShowDropdown && !loading && models.length === 0 && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownEmpty}>{emptyMessage}</div>
        </div>
      )}
      {browseHint && (
        <div className={styles.browseHint}>
          <Search size={12} className={styles.browseHintIcon} />
          <span>{browseHint}</span>
        </div>
      )}
    </div>
  )
}
