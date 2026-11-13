import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Download, Upload, Code2, Lock, Unlock } from 'lucide-react'
import { useStore } from '@/store'
import { useThemePackActions } from '@/hooks/useThemePackActions'
import { applyThemePreset } from '@/lib/themeSelection'
import { DEFAULT_THEME, normalizeTheme } from '@/theme/presets'
import { resolveMode } from '@/hooks/useThemeApplicator'
import type { ThemeConfig, ThemeMode, BaseColors, RenderingMode } from '@/types/theme'
import ModeSelector from './theme-panel/ModeSelector'
import PresetGrid from './theme-panel/PresetGrid'
import SavedThemes from './theme-panel/SavedThemes'
import ExtensionThemes from './theme-panel/ExtensionThemes'
import AccentPicker from './theme-panel/AccentPicker'
import BaseColorPicker from './theme-panel/BaseColorPicker'
import DepthControls from './theme-panel/DepthControls'
import { Toggle } from '@/components/shared/Toggle'
import {
  activeDeviceThemeControls, useDeviceThemeControls, setDeviceThemeControlsEnabled,
  updateDeviceThemeControls, resetDeviceThemeControls, resolveDeviceTheme, type ThemeControls,
} from '@/lib/deviceThemeControls'
import styles from './ThemePanel.module.css'

export default function ThemePanel() {
  const { t } = useTranslation('panels')
  const [slidersLocked, setSlidersLocked] = useState(() => window.matchMedia('(pointer: coarse)').matches)
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const setTheme = useStore((s) => s.setTheme)
  const hasExtensionOverrides = useStore((s) =>
    Object.keys(s.extensionThemeOverrides).some((id) => !s.mutedExtensionThemes[id])
  )

  const openModal = useStore((s) => s.openModal)
  // Normalize so a malformed persisted theme (e.g. missing accent) can't throw
  // when the panel reads current.accent.* — falls back to DEFAULT_THEME.
  const current = normalizeTheme(theme) ?? DEFAULT_THEME
  const deviceControls = useDeviceThemeControls(activeDeviceThemeControls)
  const deviceEnabled = useDeviceThemeControls((s) => s.enabled)
  const deviceUserId = useDeviceThemeControls((s) => s.userId)
  const appearance = resolveDeviceTheme(current, deviceControls)
  const isTauriDesktop = hasTauriDesktopBridge()

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

  const updateControls = useCallback((patch: Partial<ThemeControls>) => {
    if (activeDeviceThemeControls(useDeviceThemeControls.getState())) {
      updateDeviceThemeControls(patch, getLatest())
    } else {
      update(patch)
    }
  }, [getLatest, update])

  const handleModeChange = useCallback(
    (mode: ThemeMode) => update({ mode }),
    [update]
  )

  const handleAccentChange = useCallback(
    (h: number, s: number, l: number) => update({ accent: { h, s, l } }),
    [update]
  )

  const handleRadiusChange = useCallback(
    (radiusScale: number) => updateControls({ radiusScale }),
    [updateControls]
  )

  // Local glass controls must not change the authored theme on other devices.
  // When editing the theme itself, clear both layers in a single settings write.
  const handleGlassToggle = useCallback(
    (enableGlass: boolean) => {
      if (activeDeviceThemeControls(useDeviceThemeControls.getState())) {
        updateControls({ enableGlass })
      } else {
        update({ enableGlass, ...(!enableGlass ? { liquidGlass: false } : {}) })
      }
    },
    [update, updateControls]
  )

  const handleLiquidGlassToggle = useCallback(
    (liquidGlass: boolean) => update({ liquidGlass }),
    [update]
  )

  const handleFontScaleChange = useCallback(
    (fontScale: number) => updateControls({ fontScale }),
    [updateControls]
  )

  const handleUiScaleChange = useCallback(
    (uiScale: number) => updateControls({ uiScale }),
    [updateControls]
  )

  const handleDesktopBackgroundChange = useCallback(
    (desktopBackground?: ThemeConfig['desktopBackground']) => update({ desktopBackground }),
    [update]
  )

  const handleRenderingModeChange = useCallback(
    (renderingMode: RenderingMode) => update({ renderingMode }),
    [update]
  )

  const resolvedMode = resolveMode(current)

  const handleBaseColorsChange = useCallback(
    (baseColors: BaseColors) => update({
      baseColorsByMode: { ...current.baseColorsByMode, [resolvedMode]: baseColors },
    }),
    [update, current.baseColorsByMode, resolvedMode]
  )

  const { handleExportPack, handleImportPack } = useThemePackActions()

  const addSavedTheme = useStore((s) => s.addSavedTheme)

  const handleSaveTheme = useCallback(() => {
    const latest = getLatest()
    addSavedTheme({
      kind: 'config',
      name: latest.name || 'My Theme',
      theme: latest,
    })
  }, [getLatest, addSavedTheme])

  const lockButton = (
    <button
      type="button"
      className={`${styles.actionBtn} ${styles.sliderLockBtn}`}
      aria-pressed={slidersLocked}
      onClick={() => setSlidersLocked((locked) => !locked)}
    >
      {slidersLocked ? <Lock size={16} aria-hidden="true" /> : <Unlock size={16} aria-hidden="true" />}
      {t(slidersLocked ? 'themePanel.unlockControls' : 'themePanel.lockControls')}
    </button>
  )

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.mode')}</h4>
        <ModeSelector value={current.mode} onChange={handleModeChange} />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.presets')}</h4>
        <PresetGrid activeId={hasExtensionOverrides ? '' : current.id} onSelect={applyThemePreset} />
      </section>

      <SavedThemes />

      <ExtensionThemes />

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.accentColor')}</h4>
        {lockButton}
        <AccentPicker
          slidersLocked={slidersLocked}
          hue={current.accent.h}
          saturation={current.accent.s}
          luminance={current.accent.l}
          onChange={handleAccentChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.baseColors')}</h4>
        {lockButton}
        <fieldset disabled={slidersLocked} inert={slidersLocked} className={styles.colorControls}>
          <BaseColorPicker
            baseColors={current.baseColorsByMode?.[resolvedMode] ?? current.baseColors ?? {}}
            onChange={handleBaseColorsChange}
          />
        </fieldset>
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>{t('themePanel.controls')}</h4>
        <details className={styles.deviceControls}>
          <summary>{t('themePanel.deviceControls.title')}</summary>
          <div className={styles.deviceControlsBody}>
            <Toggle.Checkbox
              checked={deviceEnabled}
              disabled={!deviceUserId}
              onChange={(enabled) => setDeviceThemeControlsEnabled(enabled, getLatest())}
              label={t('themePanel.deviceControls.enabled')}
            />
            <p className={styles.deviceHint}>{t('themePanel.deviceControls.hint')}</p>
            <div className={styles.themeActions}>
              <button type="button" className={styles.actionBtn} disabled={!deviceControls}
                onClick={() => { if (deviceControls) update(deviceControls) }}>
                {t('themePanel.deviceControls.copyToTheme')}
              </button>
              <button type="button" className={styles.actionBtn} disabled={!deviceControls}
                onClick={() => resetDeviceThemeControls(getLatest())}>
                {t('themePanel.deviceControls.resetFromTheme')}
              </button>
            </div>
          </div>
        </details>
        {lockButton}
        <DepthControls
          slidersLocked={slidersLocked}
          radiusScale={appearance.radiusScale}
          enableGlass={appearance.enableGlass}
          liquidGlass={Boolean(appearance.liquidGlass)}
          fontScale={appearance.fontScale}
          uiScale={appearance.uiScale ?? 1}
          onRadiusChange={handleRadiusChange}
          onGlassToggle={handleGlassToggle}
          onLiquidGlassToggle={handleLiquidGlassToggle}
          onFontScaleChange={handleFontScaleChange}
          onUiScaleChange={handleUiScaleChange}
          showDesktopBackgroundControls={isTauriDesktop}
          desktopBackground={current.desktopBackground}
          onDesktopBackgroundChange={handleDesktopBackgroundChange}
          renderingMode={current.renderingMode}
          onRenderingModeChange={handleRenderingModeChange}
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
        <button type="button" className={styles.actionBtn} onClick={handleExportPack}>
          <Download size={12} /> {t('themePanel.exportTheme')}
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleImportPack}>
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
