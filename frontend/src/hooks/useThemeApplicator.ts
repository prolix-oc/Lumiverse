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
  const extensionThemeOverrides = useStore((s) => s.extensionThemeOverrides)
  const prevKeysRef = useRef<string[]>([])

  useEffect(() => {
    const config = theme ?? DEFAULT_THEME
    const mode = resolveMode(config)
    const vars = generateThemeVariables(config, mode)

    // Layer extension theme overrides on top of the base theme vars.
    // Mode-specific values (variablesByMode) take precedence over flat variables.
    const allOverrideKeys: string[] = []
    for (const override of Object.values(extensionThemeOverrides)) {
      for (const [key, value] of Object.entries(override.variables)) {
        vars[key] = value
        allOverrideKeys.push(key)
      }
      const modeVars = override.variablesByMode?.[mode]
      if (modeVars) {
        for (const [key, value] of Object.entries(modeVars)) {
          vars[key] = value
          allOverrideKeys.push(key)
        }
      }
    }

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

    // Toggle glass attribute so CSS can skip backdrop-filter entirely when disabled.
    // Suppress glass when the user prefers reduced motion — backdrop-filter is GPU-heavy.
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (config.enableGlass && !reducedMotion) {
      root.setAttribute('data-glass', '')
    } else {
      root.removeAttribute('data-glass')
    }

    // Listen for system preference changes when mode is 'system'
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateGlass = () => {
      const rm = motionMq.matches
      if (config.enableGlass && !rm) {
        root.setAttribute('data-glass', '')
      } else {
        root.removeAttribute('data-glass')
      }
    }
    motionMq.addEventListener('change', updateGlass)

    if (config.mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => {
        const newMode: ResolvedMode = mq.matches ? 'dark' : 'light'
        const newVars = generateThemeVariables(config, newMode)
        // Reapply extension overrides on mode change (with mode-aware resolution)
        for (const override of Object.values(extensionThemeOverrides)) {
          for (const [key, value] of Object.entries(override.variables)) {
            newVars[key] = value
          }
          const modeSpecific = override.variablesByMode?.[newMode]
          if (modeSpecific) {
            for (const [key, value] of Object.entries(modeSpecific)) {
              newVars[key] = value
            }
          }
        }
        applyVariables(newVars)
        root.setAttribute('data-theme-mode', newMode)
        updateGlass()
      }
      mq.addEventListener('change', handler)
      return () => {
        mq.removeEventListener('change', handler)
        motionMq.removeEventListener('change', updateGlass)
      }
    }

    return () => motionMq.removeEventListener('change', updateGlass)
  }, [theme, extensionThemeOverrides])
}
