import { useCallback } from 'react'
import { Download, Upload, Code2 } from 'lucide-react'
import { useStore } from '@/store'
import { DEFAULT_THEME } from '@/theme/presets'
import { resolveMode } from '@/hooks/useThemeApplicator'
import type { ThemeConfig, ThemeMode, BaseColors } from '@/types/theme'
import ModeSelector from './theme-panel/ModeSelector'
import PresetGrid from './theme-panel/PresetGrid'
import ExtensionThemes from './theme-panel/ExtensionThemes'
import AccentPicker from './theme-panel/AccentPicker'
import BaseColorPicker from './theme-panel/BaseColorPicker'
import DepthControls from './theme-panel/DepthControls'
import styles from './ThemePanel.module.css'

export default function ThemePanel() {
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const setTheme = useStore((s) => s.setTheme)

  const openModal = useStore((s) => s.openModal)
  const current = theme ?? DEFAULT_THEME

  // Always read the latest theme from the store to avoid stale closures
  // (e.g. useCharacterTheme may async-update accent/baseColors after render)
  const getLatest = useCallback(
    () => (useStore.getState().theme ?? DEFAULT_THEME) as ThemeConfig,
    []
  )

  const update = useCallback(
    (patch: Partial<ThemeConfig>) => {
      const latest = getLatest()
      const next = { ...latest, ...patch }
      // characterAware themes dynamically derive accent/baseColors from the
      // active character, so keep the preset id so the selection is preserved
      if (!next.characterAware) {
        next.id = 'custom'
      }
      setTheme(next as ThemeConfig)
    },
    [getLatest, setTheme]
  )

  const handleModeChange = useCallback(
    (mode: ThemeMode) => update({ mode }),
    [update]
  )

  const handlePresetSelect = useCallback(
    (preset: ThemeConfig) => {
      // Preserve the user's current mode when selecting any preset
      const latest = getLatest()
      setTheme({ ...preset, mode: latest.mode })
    },
    [setTheme, getLatest]
  )

  const handleAccentChange = useCallback(
    (h: number, s: number) => update({ accent: { h, s, l: current.accent.l } }),
    [current.accent.l, update]
  )

  const handleRadiusChange = useCallback(
    (radiusScale: number) => update({ radiusScale }),
    [update]
  )

  const handleGlassToggle = useCallback(
    (enableGlass: boolean) => update({ enableGlass }),
    [update]
  )

  const handleFontScaleChange = useCallback(
    (fontScale: number) => update({ fontScale }),
    [update]
  )

  const resolvedMode = resolveMode(current)

  const handleBaseColorsChange = useCallback(
    (baseColors: BaseColors) => update({
      baseColorsByMode: { ...current.baseColorsByMode, [resolvedMode]: baseColors },
    }),
    [update, current.baseColorsByMode, resolvedMode]
  )

  const handleExportTheme = useCallback(() => {
    const json = JSON.stringify(current, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lumiverse-theme-${current.name?.toLowerCase().replace(/\s+/g, '-') || 'custom'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [current])

  const handleImportTheme = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        if (
          typeof parsed === 'object' && parsed !== null &&
          typeof parsed.mode === 'string' &&
          typeof parsed.accent === 'object' && parsed.accent !== null
        ) {
          setTheme({ ...parsed, id: 'custom' } as ThemeConfig)
        }
      } catch { /* ignore invalid files */ }
    }
    input.click()
  }, [setTheme])

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Mode</h4>
        <ModeSelector value={current.mode} onChange={handleModeChange} />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Presets</h4>
        <PresetGrid activeId={current.id} onSelect={handlePresetSelect} />
      </section>

      <ExtensionThemes />

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Accent Color</h4>
        <AccentPicker
          hue={current.accent.h}
          saturation={current.accent.s}
          onChange={handleAccentChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Base Colors</h4>
        <BaseColorPicker
          baseColors={current.baseColorsByMode?.[resolvedMode] ?? current.baseColors ?? {}}
          onChange={handleBaseColorsChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Controls</h4>
        <DepthControls
          radiusScale={current.radiusScale}
          enableGlass={current.enableGlass}
          fontScale={current.fontScale}
          onRadiusChange={handleRadiusChange}
          onGlassToggle={handleGlassToggle}
          onFontScaleChange={handleFontScaleChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Advanced</h4>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => openModal('customCSS')}
        >
          <Code2 size={12} /> Custom CSS Editor
        </button>
      </section>

      <div className={styles.themeActions}>
        <button type="button" className={styles.actionBtn} onClick={handleExportTheme}>
          <Download size={12} /> Export Theme
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleImportTheme}>
          <Upload size={12} /> Import Theme
        </button>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={() => setTheme(null)}
        >
          Reset to Default
        </button>
      </div>
    </div>
  )
}
