import { useStore } from '@/store'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/shared/Toggle'
import { FormField, Select } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import type { OOCStyleType } from '@/types/store'
import styles from './OOCPanel.module.css'

export default function OOCPanel() {
  const { t } = useTranslation('panels')
  const oocEnabled = useStore((s) => s.oocEnabled)
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)
  const lumiaOOCInterval = useStore((s) => s.lumiaOOCInterval)
  const ircUseLeetHandles = useStore((s) => s.ircUseLeetHandles)
  const setSetting = useStore((s) => s.setSetting)

  const styleOptions = [
    { value: 'social', label: t('oocPanel.styles.social') },
    { value: 'margin', label: t('oocPanel.styles.margin') },
    { value: 'whisper', label: t('oocPanel.styles.whisper') },
    { value: 'raw', label: t('oocPanel.styles.raw') },
    { value: 'irc', label: t('oocPanel.styles.irc') },
  ]

  return (
    <div className={styles.panel}>
      {/* Enable toggle */}
      <Toggle.Checkbox
        checked={oocEnabled}
        onChange={(checked) => setSetting('oocEnabled', checked)}
        label={t('oocPanel.enable')}
      />

      {!oocEnabled && (
        <p className={styles.description}>
          {t('oocPanel.disabledDescription', { defaultValue: 'OOC comments are out-of-character asides from Lumia or Council members, shown alongside the story. Enable them to choose their display style and how often they appear.' })}
        </p>
      )}

      {oocEnabled && (
        <>
          {/* Style selector */}
          <FormField label={t('oocPanel.displayStyle')} hint={t('oocPanel.displayStyleHint')}>
            <Select
              value={lumiaOOCStyle}
              onChange={(v) => setSetting('lumiaOOCStyle', v as OOCStyleType)}
              options={styleOptions}
            />
          </FormField>

          {/* IRC-specific: L33tspeak handles */}
          {lumiaOOCStyle === 'irc' && (
            <Toggle.Checkbox
              checked={ircUseLeetHandles}
              onChange={(checked) => setSetting('ircUseLeetHandles', checked)}
              label={t('oocPanel.leetHandles')}
            />
          )}

          {/* Interval */}
          <FormField label={t('oocPanel.interval')} hint={t('oocPanel.intervalHint')}>
            <NumberStepper
              value={lumiaOOCInterval}
              onChange={(v) => setSetting('lumiaOOCInterval', v)}
              min={1}
              max={50}
              step={1}
              allowEmpty
            />
          </FormField>
        </>
      )}
    </div>
  )
}
