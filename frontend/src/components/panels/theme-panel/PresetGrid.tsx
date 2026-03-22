import type { ThemeConfig } from '@/types/theme'
import { PRESETS } from '@/theme/presets'
import { Check } from 'lucide-react'
import styles from './PresetGrid.module.css'
import clsx from 'clsx'

interface PresetGridProps {
  activeId: string
  onSelect: (preset: ThemeConfig) => void
}

const CHARACTER_AWARE_SWATCH = 'linear-gradient(135deg, #a78bfa 0%, #f472b6 50%, #38bdf8 100%)'

export default function PresetGrid({ activeId, onSelect }: PresetGridProps) {
  return (
    <div className={styles.grid}>
      {PRESETS.map((preset) => {
        const isActive = activeId === preset.id
        const isCharAware = preset.id === 'character-aware'
        const { h, s, l } = preset.accent
        const swatchBg = isCharAware
          ? CHARACTER_AWARE_SWATCH
          : `hsl(${h}, ${s}%, ${l}%)`

        return (
          <button
            key={preset.id}
            type="button"
            className={clsx(styles.card, isActive && styles.cardActive)}
            onClick={() => onSelect(preset)}
          >
            <div className={styles.swatch} style={{ background: swatchBg }}>
              {isActive && <Check size={12} strokeWidth={3} />}
            </div>
            <span className={styles.name}>{preset.name}</span>
          </button>
        )
      })}
    </div>
  )
}
