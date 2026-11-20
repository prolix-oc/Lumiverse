import { create } from 'zustand'
import { DEFAULT_THEME } from '../src/theme/presets'
import type { ThemeConfig } from '../src/types/theme'

// Controlled host for the real ThemePanel and useThemeApplicator. No backend or personal data.
export const useStore = create(() => ({
  theme: { ...DEFAULT_THEME, fontScale: 1.2, uiScale: 1.1 } as ThemeConfig | null,
  characterThemeOverlay: null,
  extensionThemeOverrides: {},
  mutedExtensionThemes: {},
  saved: null as ThemeConfig | null,
  writes: 0,
  setTheme: (theme: ThemeConfig | null) => useStore.setState((s) => ({ theme, writes: s.writes + 1 })),
  addSavedTheme: (entry: { theme: ThemeConfig }) => useStore.setState({ saved: entry.theme }),
  clearAllExtensionThemeOverrides: () => useStore.setState({ extensionThemeOverrides: {} }),
  openModal: () => {},
}))
