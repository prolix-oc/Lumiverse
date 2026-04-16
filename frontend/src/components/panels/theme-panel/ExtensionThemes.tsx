import { useMemo } from 'react'
import { Blocks } from 'lucide-react'
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

  // Fill remaining slots from any other vars that look like colors
  if (colors.length < 4) {
    for (const [key, value] of Object.entries(variables)) {
      if (colors.length >= 4) break
      if (priorities.includes(key)) continue
      // Heuristic: skip non-color values (px, ms, ease, font, linear-gradient, etc.)
      if (/^[0-9.]+px|^[0-9.]+ms|ease|font|gradient|inset|blur/i.test(value)) continue
      colors.push(value)
    }
  }

  return colors.length > 0 ? colors : ['var(--lumiverse-primary)']
}

function ActiveThemeCard({ override }: { override: ExtensionThemeOverride }) {
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
          {varCount} override{varCount !== 1 ? 's' : ''} applied
        </span>
      </div>
      <Toggle.Switch
        checked={true}
        onChange={() => muteTheme(override.extensionId)}
      />
    </div>
  )
}

function MutedThemeCard({ extensionId }: { extensionId: string }) {
  const unmuteTheme = useStore((s) => s.unmuteExtensionTheme)
  const extensions = useStore((s) => s.extensions)
  const name = extensions.find((e) => e.id === extensionId)?.name ?? extensionId

  return (
    <div className={styles.card} style={{ opacity: 0.5 }}>
      <div className={styles.swatches}>
        <div className={styles.swatch} style={{ background: 'var(--lumiverse-fill-medium)' }} />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{name}</span>
        <span className={styles.attribution}>Theme disabled</span>
      </div>
      <Toggle.Switch
        checked={false}
        onChange={() => unmuteTheme(extensionId)}
      />
    </div>
  )
}

export default function ExtensionThemes() {
  const overrides = useStore((s) => s.extensionThemeOverrides)
  const muted = useStore((s) => s.mutedExtensionThemes)

  const activeEntries = useMemo(() => Object.values(overrides), [overrides])
  const mutedIds = useMemo(() => Object.keys(muted), [muted])

  if (activeEntries.length === 0 && mutedIds.length === 0) return null

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.headerIcon}><Blocks size={12} /></span>
        <h4 className={styles.headerLabel}>Extension Themes</h4>
      </div>
      <div className={styles.list}>
        {activeEntries.map((override) => (
          <ActiveThemeCard key={override.extensionId} override={override} />
        ))}
        {mutedIds.map((id) => (
          <MutedThemeCard key={id} extensionId={id} />
        ))}
      </div>
    </div>
  )
}
