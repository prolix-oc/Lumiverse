import type { ThemeMode } from '@/types/theme'
import { Sun, Moon, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styles from './ModeSelector.module.css'
import clsx from 'clsx'

interface ModeSelectorProps {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}

const MODES: { id: ThemeMode; icon: typeof Sun; labelKey: 'modes.dark' | 'modes.light' | 'modes.system' }[] = [
  { id: 'dark', icon: Moon, labelKey: 'modes.dark' },
  { id: 'light', icon: Sun, labelKey: 'modes.light' },
  { id: 'system', icon: Monitor, labelKey: 'modes.system' },
]

export default function ModeSelector({ value, onChange }: ModeSelectorProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'themePanel' })

  return (
    <div className={styles.segmented}>
      {MODES.map(({ id, icon: Icon, labelKey }) => (
        <button
          key={id}
          type="button"
          className={clsx(styles.segment, value === id && styles.segmentActive)}
          onClick={() => onChange(id)}
        >
          <Icon size={14} />
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </div>
  )
}
