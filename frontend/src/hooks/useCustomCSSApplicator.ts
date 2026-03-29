import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '@/store'
import { validateCSS, sanitizeCSS } from '@/lib/cssValidator'
import { toast } from '@/lib/toast'

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
 * single string, then inject via a <style> element in @layer lumiverse-user.
 */
export function useCustomCSSApplicator() {
  const customCSS = useStore((s) => s.customCSS)
  const componentOverrides = useStore((s) => s.componentOverrides)
  const toggleCustomCSS = useStore((s) => s.toggleCustomCSS)
  const lastHashRef = useRef('')

  useEffect(() => {
    const el = getOrCreateStyleElement()

    // Collect all CSS sources
    const parts: string[] = []

    // Global CSS (if enabled)
    if (customCSS.enabled && customCSS.css.trim()) {
      parts.push(sanitizeCSS(customCSS.css))
    }

    // Per-component CSS (from enabled overrides)
    for (const [, override] of Object.entries(componentOverrides)) {
      if (override.enabled && override.css?.trim()) {
        parts.push(sanitizeCSS(override.css))
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
      el.textContent = `@layer lumiverse-user {\n${combined}\n}`
      lastHashRef.current = combined
    } else {
      toast.error(`Custom CSS error: ${result.error}`)
    }
  }, [customCSS.css, customCSS.enabled, customCSS.revision, componentOverrides])

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
      toast.info('Custom CSS disabled')
    }
  }, [toggleCustomCSS])

  useEffect(() => {
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [handleEscape])
}
