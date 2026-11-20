import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { DrawerSettings } from '@/types/store'
import styles from '@/components/modals/SettingsModal.module.css'

export default function DrawerWidthSettings({ settings, onChange }: {
  settings: DrawerSettings
  onChange: (patch: Partial<DrawerSettings>) => void
}) {
  const { t } = useTranslation('settings')
  const id = useId()
  return (
    <div className={styles.field}>
      <span id={id} className={styles.fieldLabel}>{t('display.drawer.panelWidth')}</span>
      <div className={styles.segmented} role="group" aria-labelledby={id}>
        {(['default', 'custom'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={clsx(styles.segmentedBtn, settings.panelWidthMode === mode && styles.segmentedBtnActive)}
            aria-pressed={settings.panelWidthMode === mode}
            onClick={() => onChange({ panelWidthMode: mode, panelWidthPx: undefined })}
          >
            {t(mode === 'default' ? 'display.drawer.panelDefault' : 'display.drawer.panelCustom')}
          </button>
        ))}
      </div>
      {settings.panelWidthMode === 'custom' && (
        <>
          <label htmlFor={id + '-width'} className={styles.fieldLabel}>{t('display.drawer.customWidthVw')}</label>
          <div className={styles.rangeRow}>
            <input
              id={id + '-width'}
              type="range"
              className={styles.rangeSlider}
              min={20}
              max={80}
              step={1}
              value={settings.customPanelWidth}
              onChange={(event) => onChange({ customPanelWidth: Number(event.target.value), panelWidthPx: undefined })}
            />
            <span className={styles.rangeValue}>{settings.customPanelWidth}vw</span>
          </div>
        </>
      )}
    </div>
  )
}
