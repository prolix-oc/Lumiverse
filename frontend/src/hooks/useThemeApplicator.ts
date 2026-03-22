import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { generateThemeVariables } from '@/theme/engine'
import { DEFAULT_THEME } from '@/theme/presets'
import type { ResolvedMode, ThemeConfig } from '@/types/theme'

export function resolveMode(config: ThemeConfig): ResolvedMode {
  if (config.mode !== 'system') return config.mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyVariables(vars: Record<string, string>) {
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}

export function useThemeApplicator() {
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const prevKeysRef = useRef<string[]>([])

  useEffect(() => {
    const config = theme ?? DEFAULT_THEME
    const mode = resolveMode(config)
    const vars = generateThemeVariables(config, mode)

    // Remove any previously set keys that aren't in the new set
    const root = document.documentElement
    const newKeys = Object.keys(vars)
    for (const key of prevKeysRef.current) {
      if (!vars[key]) {
        root.style.removeProperty(key)
      }
    }
    prevKeysRef.current = newKeys

    applyVariables(vars)
    root.setAttribute('data-theme-mode', mode)

    // Toggle glass attribute so CSS can skip backdrop-filter entirely when disabled
    if (config.enableGlass) {
      root.setAttribute('data-glass', '')
    } else {
      root.removeAttribute('data-glass')
    }

    // Listen for system preference changes when mode is 'system'
    if (config.mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => {
        const newMode: ResolvedMode = mq.matches ? 'dark' : 'light'
        const newVars = generateThemeVariables(config, newMode)
        applyVariables(newVars)
        root.setAttribute('data-theme-mode', newMode)
        if (config.enableGlass) {
          root.setAttribute('data-glass', '')
        } else {
          root.removeAttribute('data-glass')
        }
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])
}
