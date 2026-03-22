/**
 * Two responsibilities:
 *
 * 1. **Character name colors** (always active): Extracts a palette from the active
 *    character's avatar and sets `--char-name-dark` / `--char-name-light` on the root.
 *    These are vibrant, theme-mode-aware name colors used in chat messages.
 *
 * 2. **Character-aware theme overlay** (opt-in via `characterAware: true`): Merges
 *    accent + base colors derived from the avatar onto the current theme.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { extractPalette, type ImagePalette } from '@/lib/colorExtraction'
import { deriveCharacterOverlay, deriveCharacterNameVars } from '@/lib/characterTheme'
import type { ThemeConfig } from '@/types/theme'

/** In-memory palette cache keyed by character ID to avoid re-extraction. */
const paletteCache = new Map<string, ImagePalette>()

/** Keys we set on the root so we can clean them up. */
const NAME_VAR_KEYS = ['--char-name-dark', '--char-name-light']

export function useCharacterTheme() {
  const characterAware = useStore((s) => (s.theme as ThemeConfig | null)?.characterAware === true)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const appliedCharIdRef = useRef<string | null>(null)
  const nameAppliedCharIdRef = useRef<string | null>(null)

  // ── 1. Character name colors (always active) ──
  useEffect(() => {
    const root = document.documentElement

    if (!activeCharacterId) {
      NAME_VAR_KEYS.forEach((k) => root.style.removeProperty(k))
      nameAppliedCharIdRef.current = null
      return
    }

    if (nameAppliedCharIdRef.current === activeCharacterId) return

    let cancelled = false

    const apply = async () => {
      try {
        const avatarUrl = charactersApi.avatarUrl(activeCharacterId)

        let palette = paletteCache.get(activeCharacterId)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(activeCharacterId, palette)
        }

        if (cancelled) return

        const vars = deriveCharacterNameVars(palette)
        for (const [key, value] of Object.entries(vars)) {
          root.style.setProperty(key, value)
        }
        nameAppliedCharIdRef.current = activeCharacterId
      } catch (err) {
        console.warn('[useCharacterTheme] Name color extraction failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [activeCharacterId])

  // ── 2. Character-aware theme overlay (opt-in) ──
  useEffect(() => {
    if (!characterAware) {
      appliedCharIdRef.current = null
      return
    }

    if (!activeCharacterId) return
    if (appliedCharIdRef.current === activeCharacterId) return

    let cancelled = false

    const apply = async () => {
      try {
        const avatarUrl = charactersApi.avatarUrl(activeCharacterId)

        let palette = paletteCache.get(activeCharacterId)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(activeCharacterId, palette)
        }

        if (cancelled) return

        const overlay = deriveCharacterOverlay(palette)

        const current = useStore.getState().theme as ThemeConfig | null
        if (!current?.characterAware) return

        appliedCharIdRef.current = activeCharacterId

        useStore.getState().setTheme({
          ...current,
          accent: overlay.accent,
          baseColors: {
            ...current.baseColors,
            ...overlay.baseColors,
          },
        })
      } catch (err) {
        console.warn('[useCharacterTheme] Theme overlay failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [characterAware, activeCharacterId])
}
