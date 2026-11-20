import ConnectionSelect from '@/components/shared/ConnectionSelect'
import { useTranslation } from 'react-i18next'
import styles from './SidecarConnectionPicker.module.css'

export interface SidecarConnectionPickerProps {
  label?: string
  ariaLabel?: string
  connectionProfileId: string | null
  model: string | null
  onConnectionChange: (profileId: string | null) => void
  onModelChange: (model: string | null) => void
  placeholder?: string
  hint?: string | null
  onRemove?: () => void
  removeLabel?: string
  removeTestId?: string
  testId?: string
  disabled?: boolean
}

export default function SidecarConnectionPicker({
  label = 'Connection',
  ariaLabel,
  connectionProfileId,
  model,
  onConnectionChange,
  onModelChange,
  placeholder,
  hint,
  onRemove,
  removeLabel,
  removeTestId,
  testId,
  disabled = false,
}: SidecarConnectionPickerProps) {
  const { t } = useTranslation('settings')
  const empty = placeholder ?? t('memoryCortex.connectionNone')
  return (
    <div className={styles.pickerStack} data-testid={testId}>
      <div className={styles.pickerHeader}>
        <span className={styles.pickerLabel}>{label}</span>
        {onRemove ? (
          <button
            type="button"
            className={styles.tagRemove}
            onClick={onRemove}
            aria-label={removeLabel ?? t('memoryCortex.removeFallback', { defaultValue: 'Remove fallback' })}
            data-testid={removeTestId}
          >
            &times;
          </button>
        ) : null}
      </div>
      <div className={styles.pickerControl}>
        <ConnectionSelect
          kind="llm"
          value={connectionProfileId || ''}
          onChange={(value) => onConnectionChange(value || null)}
          withModel
          seedDefaultModel={false}
          modelValue={model || ''}
          onModelChange={(value) => onModelChange(value || null)}
          clearable
          clearLabel={empty}
          placeholder={empty}
          searchPlaceholder={t('memoryCortex.searchConnections', { defaultValue: 'Search connections…' })}
          emptyMessage={t('memoryCortex.noConnections', { defaultValue: 'No LLM connections configured' })}
          ariaLabel={ariaLabel ?? label}
          modelPlaceholder={t('memoryCortex.modelPlaceholder')}
          modelEmptyMessage={t('memoryCortex.noModels')}
          modelNoConnectionMessage={t('memoryCortex.selectConnectionFirst', { defaultValue: 'Select a connection first' })}
          modelAppearance="standard"
          portal
          disabled={disabled}
        />
      </div>
      {hint ? <p className={styles.pickerHint}>{hint}</p> : null}
    </div>
  )
}
