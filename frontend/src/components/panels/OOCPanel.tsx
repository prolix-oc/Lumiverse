import { useStore } from '@/store'
import { FormField, Select } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import type { OOCStyleType } from '@/types/store'
import styles from './OOCPanel.module.css'

const STYLE_OPTIONS = [
  { value: 'social', label: 'Social Card' },
  { value: 'margin', label: 'Margin Note' },
  { value: 'whisper', label: 'Whisper Bubble' },
  { value: 'raw', label: 'Raw Text' },
  { value: 'irc', label: 'IRC Chat Room' },
]

export default function OOCPanel() {
  const oocEnabled = useStore((s) => s.oocEnabled)
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)
  const lumiaOOCInterval = useStore((s) => s.lumiaOOCInterval)
  const ircUseLeetHandles = useStore((s) => s.ircUseLeetHandles)
  const setSetting = useStore((s) => s.setSetting)

  return (
    <div className={styles.panel}>
      {/* Enable toggle */}
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={oocEnabled}
          onChange={(e) => setSetting('oocEnabled', e.target.checked)}
        />
        <span>Enable OOC comments</span>
      </label>

      {oocEnabled && (
        <>
          {/* Style selector */}
          <FormField label="Display Style" hint="How OOC comments appear in chat">
            <Select
              value={lumiaOOCStyle}
              onChange={(v) => setSetting('lumiaOOCStyle', v as OOCStyleType)}
              options={STYLE_OPTIONS}
            />
          </FormField>

          {/* IRC-specific: L33tspeak handles */}
          {lumiaOOCStyle === 'irc' && (
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={ircUseLeetHandles}
                onChange={(e) => setSetting('ircUseLeetHandles', e.target.checked)}
              />
              <span>L33tspeak Handles</span>
            </label>
          )}

          {/* Interval */}
          <FormField label="OOC Interval" hint="Messages between OOC comments (empty = automatic)">
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
