import { useStore } from '@/store'
import { DEFAULT_THEME } from '@/theme/presets'
import type { ThemeConfig } from '@/types/theme'

/**
 * Apply a built-in theme preset like the Theme panel does: extension theme
 * overrides are cleared so the preset takes full control, and the current
 * mode plus wrapper-owned appearance are kept.
 */
export function applyThemePreset(preset: ThemeConfig): void {
  const state = useStore.getState()
  const latest = (state.theme ?? DEFAULT_THEME) as ThemeConfig
  state.clearAllExtensionThemeOverrides()
  // Older presets predate desktopBackground; without the fallback they would
  // clear it and turn the Tauri blur off.
  state.setTheme({
    ...preset,
    mode: latest.mode,
    desktopBackground: preset.desktopBackground ?? latest.desktopBackground,
    renderingMode: preset.renderingMode ?? latest.renderingMode,
  })
}
