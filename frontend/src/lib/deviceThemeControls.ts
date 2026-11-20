import { create } from 'zustand'
import { DEFAULT_THEME } from '@/theme/presets'
import { normalizeUiScale } from './uiScale'
import type { ThemeConfig } from '@/types/theme'

export type ThemeControls = Pick<ThemeConfig, 'radiusScale' | 'fontScale' | 'enableGlass'> & { uiScale: number }

interface DeviceThemeControlsState {
  userId: string | null
  enabled: boolean
  controls: ThemeControls | null
}

const emptyState: DeviceThemeControlsState = { userId: null, enabled: false, controls: null }
export const useDeviceThemeControls = create<DeviceThemeControlsState>(() => emptyState)

function finiteScale(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback
}

export function themeControls(theme: Partial<ThemeConfig> | null): ThemeControls {
  return {
    radiusScale: finiteScale(theme?.radiusScale, DEFAULT_THEME.radiusScale, 0.5, 2),
    fontScale: finiteScale(theme?.fontScale, DEFAULT_THEME.fontScale, 0.85, 2),
    uiScale: normalizeUiScale(theme?.uiScale),
    enableGlass: typeof theme?.enableGlass === 'boolean' ? theme.enableGlass : DEFAULT_THEME.enableGlass,
  }
}

function storageKey(userId: string): string {
  return `lumiverse.device-theme-controls:${userId}`
}

function readState(userId: string): DeviceThemeControlsState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) ?? 'null')
    if (value?.version === 1 && value.controls && typeof value.controls === 'object' && !Array.isArray(value.controls)) {
      return { userId, enabled: value.enabled === true, controls: themeControls(value.controls) }
    }
  } catch { /* Missing or unavailable storage falls back to the theme. */ }
  return { ...emptyState, userId }
}

/** Called before startup settings are hydrated, so the first theme paint uses local controls. */
export function setDeviceThemeControlsScope(userId: string | null): void {
  if (useDeviceThemeControls.getState().userId === userId) return
  useDeviceThemeControls.setState(userId ? readState(userId) : emptyState)
}

function writeState(state: DeviceThemeControlsState): void {
  if (!state.userId) return
  useDeviceThemeControls.setState(state)
  try {
    localStorage.setItem(storageKey(state.userId), JSON.stringify({ version: 1, enabled: state.enabled, controls: state.controls }))
  } catch { /* Keep controls usable for this session when storage is unavailable. */ }
}

export function setDeviceThemeControlsEnabled(enabled: boolean, theme: ThemeConfig | null): void {
  const state = useDeviceThemeControls.getState()
  writeState({ ...state, enabled, controls: state.controls ?? themeControls(theme) })
}

export function updateDeviceThemeControls(patch: Partial<ThemeControls>, theme: ThemeConfig | null): void {
  const state = useDeviceThemeControls.getState()
  writeState({ ...state, controls: themeControls({ ...(state.controls ?? themeControls(theme)), ...patch }) })
}

export function resetDeviceThemeControls(theme: ThemeConfig | null): void {
  writeState({ ...useDeviceThemeControls.getState(), controls: themeControls(theme) })
}

export function resolveDeviceTheme(theme: ThemeConfig | null, controls: ThemeControls | null): ThemeConfig {
  const config = theme ?? DEFAULT_THEME
  return controls ? { ...config, ...controls } : config
}

export function activeDeviceThemeControls(state: DeviceThemeControlsState): ThemeControls | null {
  return state.enabled ? state.controls : null
}

// Other tabs and detached same-origin windows share this device's preferences.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    const { userId } = useDeviceThemeControls.getState()
    if (userId && (event.key === null || event.key === storageKey(userId))) {
      useDeviceThemeControls.setState(readState(userId))
    }
  })
}
