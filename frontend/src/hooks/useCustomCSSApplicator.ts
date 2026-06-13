import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '@/store'
import { validateCSS, sanitizeCSS } from '@/lib/cssValidator'
import { rewriteThemeAssetUrls } from '@/lib/themeAssetCss'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'

const STYLE_ID = 'lumiverse-user-css'

function getOrCreateStyleElement(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  return el
}

/**
 * Flatten global CSS + all enabled per-component CSS overrides into a
 * single late-injected <style> element. Keep this unlayered so user CSS
 * can override the app's unlayered CSS modules without requiring !important.
 */
export function useCustomCSSApplicator() {
  const customCSS = useStore((s) => s.customCSS)
  const componentOverrides = useStore((s) => s.componentOverrides)
  const toggleCustomCSS = useStore((s) => s.toggleCustomCSS)
  const toggleComponentOverride = useStore((s) => s.toggleComponentOverride)
  const lastHashRef = useRef('')

  useEffect(() => {
    const el = getOrCreateStyleElement()

    try {
      // Collect all CSS sources
      const parts: string[] = []

      // Global CSS (independent toggle)
      if (customCSS.enabled && customCSS.css.trim()) {
        parts.push(rewriteThemeAssetUrls(sanitizeCSS(customCSS.css), customCSS.bundleId))
      }

      // Per-component CSS — each override has its own toggle, independent of global
      for (const [, override] of Object.entries(componentOverrides)) {
        if (override.enabled && override.css?.trim()) {
          parts.push(rewriteThemeAssetUrls(sanitizeCSS(override.css), customCSS.bundleId))
        }
      }

      if (parts.length === 0) {
        el.textContent = ''
        lastHashRef.current = ''
        return
      }

      const combined = parts.join('\n\n')

      // Skip if nothing changed
      if (combined === lastHashRef.current) return

      const result = validateCSS(combined)
      if (result.valid) {
        el.textContent = combined
        lastHashRef.current = combined
      } else {
        toast.error(i18n.t('common.toast.customCssError', { error: result.error }))
      }
    } catch (err) {
      // The transforms (sanitize/rewrite) can throw on pathological input —
      // e.g. encodeURIComponent() rejects malformed UTF-16 in url() paths.
      // This hook runs at the app root inside the only ErrorBoundary, so an
      // uncaught throw here tears down the whole app. Surface a toast and keep
      // the previously-applied CSS in place instead of crashing.
      toast.error(i18n.t('common.toast.customCssError', { error: (err as Error).message }))
    }
  }, [customCSS.bundleId, customCSS.css, customCSS.enabled, customCSS.revision, componentOverrides])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const el = document.getElementById(STYLE_ID)
      if (el) el.textContent = ''
    }
  }, [])

  // Emergency escape: Ctrl+Shift+U disables all custom styling
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'U') {
      e.preventDefault()
      toggleCustomCSS(false)
      for (const name of Object.keys(componentOverrides)) {
        toggleComponentOverride(name, false)
      }
      toast.info(i18n.t('common.toast.customCssDisabled'))
    }
  }, [toggleCustomCSS, toggleComponentOverride, componentOverrides])

  useEffect(() => {
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [handleEscape])
}
