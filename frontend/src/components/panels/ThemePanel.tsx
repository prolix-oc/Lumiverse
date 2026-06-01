import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Download, Upload, Code2 } from 'lucide-react'
import { useStore } from '@/store'
import { DEFAULT_THEME, normalizeTheme } from '@/theme/presets'
import { resolveMode } from '@/hooks/useThemeApplicator'
import type { ThemeConfig, ThemeMode, BaseColors } from '@/types/theme'
import ModeSelector from './theme-panel/ModeSelector'
import PresetGrid from './theme-panel/PresetGrid'
import SavedThemes from './theme-panel/SavedThemes'
import ExtensionThemes from './theme-panel/ExtensionThemes'
import AccentPicker from './theme-panel/AccentPicker'
import BaseColorPicker from './theme-panel/BaseColorPicker'
import DepthControls from './theme-panel/DepthControls'
import styles from './ThemePanel.module.css'

export default function ThemePanel() {
  const { t } = useTranslation('panels')
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const setTheme = useStore((s) => s.setTheme)
  const hasExtensionOverrides = useStore((s) =>
    Object.keys(s.extensionThemeOverrides).some((id) => !s.mutedExtensionThemes[id])
  )

  const openModal = useStore((s) => s.openModal)
  const bubbleUseFullAvatar = useStore((s) => s.bubbleUseFullAvatar ?? false)
  const setSetting = useStore((s) => s.setSetting)
  // Normalize so a malformed persisted theme (e.g. missing accent) can't throw
  // when the panel reads current.accent.* — falls back to DEFAULT_THEME.
  const current = normalizeTheme(theme) ?? DEFAULT_THEME

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

  const clearAllExtensionThemeOverrides = useStore((s) => s.clearAllExtensionThemeOverrides)

  const handlePresetSelect = useCallback(
    (preset: ThemeConfig) => {
      // Preserve the user's current mode when selecting any preset
      const latest = getLatest()
      // Clear extension theme overrides so the preset takes full control
      clearAllExtensionThemeOverrides()
      setTheme({ ...preset, mode: latest.mode })
    },
    [setTheme, getLatest, clearAllExtensionThemeOverrides]
  )

  const handleAccentChange = useCallback(
    (h: number, s: number, l: number) => update({ accent: { h, s, l } }),
    [update]
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

  const handleUiScaleChange = useCallback(
    (uiScale: number) => update({ uiScale }),
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

  const addSavedTheme = useStore((s) => s.addSavedTheme)

  const handleSaveTheme = useCallback(() => {
    const latest = getLatest()
    addSavedTheme({
      kind: 'config',
      name: latest.name || 'My Theme',
      theme: latest,
    })
  }, [getLatest, addSavedTheme])

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
          const importedTheme = { ...parsed, id: 'custom' } as ThemeConfig
          const baseName = file.name.replace(/\.json$/i, '').replace(/^lumiverse-theme-/i, '')
          const name = parsed.name || baseName || t('themePanel.importedTheme')
          addSavedTheme({ kind: 'config', name, theme: { ...importedTheme, name } })
          setTheme(importedTheme)
        }
      } catch { /* ignore invalid files */ }
    }
    input.click()
  }, [setTheme, addSavedTheme, t])

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.mode')}</h4>
        <ModeSelector value={current.mode} onChange={handleModeChange} />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.presets')}</h4>
        <PresetGrid activeId={hasExtensionOverrides ? '' : current.id} onSelect={handlePresetSelect} />
      </section>

      <SavedThemes />

      <ExtensionThemes />

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.accentColor')}</h4>
        <AccentPicker
          hue={current.accent.h}
          saturation={current.accent.s}
          luminance={current.accent.l}
          onChange={handleAccentChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.baseColors')}</h4>
        <BaseColorPicker
          baseColors={current.baseColorsByMode?.[resolvedMode] ?? current.baseColors ?? {}}
          onChange={handleBaseColorsChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.controls')}</h4>
        <DepthControls
          radiusScale={current.radiusScale}
          enableGlass={current.enableGlass}
          useFullAvatar={bubbleUseFullAvatar}
          fontScale={current.fontScale}
          uiScale={current.uiScale ?? 1}
          onRadiusChange={handleRadiusChange}
          onGlassToggle={handleGlassToggle}
          onFullAvatarToggle={(v) => setSetting('bubbleUseFullAvatar', v)}
          onFontScaleChange={handleFontScaleChange}
          onUiScaleChange={handleUiScaleChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.advanced')}</h4>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => openModal('customCSS')}
        >
          <Code2 size={12} /> {t('themePanel.customCssEditor')}
        </button>
      </section>

      <div className={styles.themeActions}>
        <button type="button" className={styles.actionBtn} onClick={handleExportTheme}>
          <Download size={12} /> {t('themePanel.exportTheme')}
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleImportTheme}>
          <Upload size={12} /> {t('themePanel.importTheme')}
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleSaveTheme}>
          <Bookmark size={12} /> Save to My Themes
        </button>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={() => setTheme(null)}
        >
          {t('themePanel.resetToDefault')}
        </button>
      </div>
    </div>
  )
}
