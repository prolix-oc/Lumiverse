import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { themeAssetsApi } from '@/api/theme-assets'
import { toast } from '@/lib/toast'
import { createThemePackActions } from '@/lib/themePackActions'

export function useThemePackActions() {
  const { t } = useTranslation('modals', { keyPrefix: 'customCss' })
  const theme = useStore((s) => s.theme)
  const customCSS = useStore((s) => s.customCSS)
  const componentOverrides = useStore((s) => s.componentOverrides)
  const savedThemes = useStore((s) => s.savedThemes)
  const applyThemePack = useStore((s) => s.applyThemePack)
  const addSavedTheme = useStore((s) => s.addSavedTheme)

  return useMemo(() => createThemePackActions(
    { theme, customCSS, componentOverrides, savedThemes, applyThemePack, addSavedTheme },
    { t, themeAssetsApi, toast },
  ), [theme, customCSS, componentOverrides, savedThemes, applyThemePack, addSavedTheme, t])
}
