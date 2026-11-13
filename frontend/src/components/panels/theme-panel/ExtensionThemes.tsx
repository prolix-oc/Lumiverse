import { useMemo } from 'react'
import { Blocks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/shared/Toggle'
import { useStore } from '@/store'
import type { ExtensionThemeOverride } from '@/types/store'
import styles from './ExtensionThemes.module.css'

/**
 * Extract up to 4 representative colors from a CSS variable override set.
 * Prioritizes primary, bg, and accent-style vars for the swatch strip.
 */
function extractSwatchColors(variables: Record<string, string>): string[] {
  const priorities = [
    '--lumiverse-primary',
    '--lumiverse-bg',
    '--lumiverse-bg-elevated',
    '--lcs-glass-bg',
    '--lumiverse-text',
    '--lumiverse-danger',
    '--lumiverse-success',
    '--lumiverse-warning',
    '--lumiverse-border',
  ]

  const colors: string[] = []
  for (const key of priorities) {
    if (variables[key] && colors.length < 4) {
      colors.push(variables[key])
    }
  }

  if (colors.length < 4) {
    for (const [key, value] of Object.entries(variables)) {
      if (colors.length >= 4) break
      if (priorities.includes(key)) continue
      if (/^[0-9.]+px|^[0-9.]+ms|ease|font|gradient|inset|blur/i.test(value)) continue
      colors.push(value)
    }
  }

  return colors.length > 0 ? colors : ['var(--lumiverse-primary)']
}

function ActiveThemeCard({ override }: { override: ExtensionThemeOverride }) {
  const { t } = useTranslation('panels', { keyPrefix: 'themePanel' })
  const muteTheme = useStore((s) => s.muteExtensionTheme)
  const swatches = useMemo(() => extractSwatchColors(override.variables), [override.variables])
  const varCount = Object.keys(override.variables).length

  return (
    <div className={styles.card}>
      <div className={styles.swatches}>
        {swatches.map((color, i) => (
          <div key={i} className={styles.swatch} style={{ background: color }} />
        ))}
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{override.extensionName}</span>
        <span className={styles.attribution}>
          {t('overridesApplied', { count: varCount })}
        </span>
      </div>
      <Toggle.Switch
        checked={true}
        onChange={() => muteTheme(override.extensionId)}
      />
    </div>
  )
}

function MutedThemeCard({ override }: { override: ExtensionThemeOverride }) {
  const { t } = useTranslation('panels', { keyPrefix: 'themePanel' })
  const unmuteTheme = useStore((s) => s.unmuteExtensionTheme)
  const swatches = useMemo(() => extractSwatchColors(override.variables), [override.variables])

  return (
    <div className={styles.card} style={{ opacity: 0.5 }}>
      <div className={styles.swatches}>
        {swatches.map((color, i) => (
          <div key={i} className={styles.swatch} style={{ background: color }} />
        ))}
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{override.extensionName}</span>
        <span className={styles.attribution}>{t('themeDisabled')}</span>
      </div>
      <Toggle.Switch
        checked={false}
        onChange={() => unmuteTheme(override.extensionId)}
      />
    </div>
  )
}

export default function ExtensionThemes() {
  const { t } = useTranslation('panels', { keyPrefix: 'themePanel' })
  const overrides = useStore((s) => s.extensionThemeOverrides)
  const muted = useStore((s) => s.mutedExtensionThemes)

  const entries = useMemo(() => Object.values(overrides), [overrides])

  if (entries.length === 0) return null

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.headerIcon}><Blocks size={12} /></span>
        <h4 className={styles.headerLabel}>{t('extensionThemesTitle')}</h4>
      </div>
      <div className={styles.list}>
        {entries.map((override) =>
          muted[override.extensionId]
            ? <MutedThemeCard key={override.extensionId} override={override} />
            : <ActiveThemeCard key={override.extensionId} override={override} />
        )}
      </div>
    </div>
  )
}
