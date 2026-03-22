import type { ThemeMode } from '@/types/theme'
import { Sun, Moon, Monitor } from 'lucide-react'
import styles from './ModeSelector.module.css'
import clsx from 'clsx'

interface ModeSelectorProps {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}

const MODES: { id: ThemeMode; icon: typeof Sun; label: string }[] = [
  { id: 'dark', icon: Moon, label: 'Dark' },
  { id: 'light', icon: Sun, label: 'Light' },
  { id: 'system', icon: Monitor, label: 'System' },
]

export default function ModeSelector({ value, onChange }: ModeSelectorProps) {
  return (
    <div className={styles.segmented}>
      {MODES.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          className={clsx(styles.segment, value === id && styles.segmentActive)}
          onClick={() => onChange(id)}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
