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
import { getCharacterAvatarThumbUrlById } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import { extractPalette, type ImagePalette } from '@/lib/colorExtraction'
import { deriveCharacterOverlay, deriveCharacterNameVars } from '@/lib/characterTheme'
import { resolveMode } from '@/hooks/useThemeApplicator'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { ThemeConfig } from '@/types/theme'

/** In-memory palette cache keyed by avatar identity to avoid re-extraction. */
const paletteCache = new Map<string, ImagePalette>()

/** Keys we set on the root so we can clean them up. */
const NAME_VAR_KEYS = ['--char-name-dark', '--char-name-light']

export function useCharacterTheme() {
  const characterAware = useStore((s) => (s.theme as ThemeConfig | null)?.characterAware === true)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const characters = useStore((s) => s.characters)
  const activeCharacter = activeCharacterId
    ? characters.find((entry) => entry.id === activeCharacterId) ?? null
    : null

  // Prefer the chat's active avatar override, fall back to character's default
  const effectiveImageId = activeChatAvatarId ?? activeCharacter?.image_id ?? null
  const avatarUrl = activeChatAvatarId
    ? imagesApi.smallUrl(activeChatAvatarId)
    : getCharacterAvatarThumbUrlById(activeCharacterId, activeCharacter?.image_id ?? null)
  const avatarCacheKey = activeCharacterId
    ? `${activeCharacterId}:${effectiveImageId ?? 'legacy'}`
    : null
  const appliedAvatarKeyRef = useRef<string | null>(null)
  const nameAppliedAvatarKeyRef = useRef<string | null>(null)

  // ── 1. Character name colors (always active) ──
  useEffect(() => {
    const root = document.documentElement

    if (!activeCharacterId || !avatarUrl || !avatarCacheKey) {
      NAME_VAR_KEYS.forEach((k) => root.style.removeProperty(k))
      nameAppliedAvatarKeyRef.current = null
      return
    }

    if (nameAppliedAvatarKeyRef.current === avatarCacheKey) return

    let cancelled = false

    const apply = async () => {
      try {
        let palette = paletteCache.get(avatarCacheKey)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(avatarCacheKey, palette)
        }

        if (cancelled) return

        const vars = deriveCharacterNameVars(palette)
        for (const [key, value] of Object.entries(vars)) {
          root.style.setProperty(key, value)
        }
        nameAppliedAvatarKeyRef.current = avatarCacheKey
      } catch (err) {
        console.warn('[useCharacterTheme] Name color extraction failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [activeCharacterId, avatarUrl, avatarCacheKey])

  // ── 2. Character-aware theme overlay (opt-in) ──
  useEffect(() => {
    if (!characterAware) {
      appliedAvatarKeyRef.current = null
      return
    }

    if (!activeCharacterId || !avatarUrl || !avatarCacheKey) return
    if (appliedAvatarKeyRef.current === avatarCacheKey) return

    let cancelled = false

    const apply = async () => {
      try {
        let palette = paletteCache.get(avatarCacheKey)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(avatarCacheKey, palette)
        }

        if (cancelled) return

        const overlay = deriveCharacterOverlay(palette)

        const current = useStore.getState().theme as ThemeConfig | null
        if (!current?.characterAware) return

        appliedAvatarKeyRef.current = avatarCacheKey

        // Write mode-appropriate overlay colors: dark-tuned baseColors for
        // dark mode, light-tuned baseColorsLight for light mode.
        const existingByMode = current.baseColorsByMode ?? {}
        useStore.getState().setTheme({
          ...current,
          accent: overlay.accent,
          baseColorsByMode: {
            dark: { ...existingByMode.dark, ...overlay.baseColors },
            light: { ...existingByMode.light, ...overlay.baseColorsLight },
          },
        })
      } catch (err) {
        console.warn('[useCharacterTheme] Theme overlay failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [characterAware, activeCharacterId, avatarUrl, avatarCacheKey])

  // ── 3. React to CHARACTER_AVATAR_CHANGED — force resample ──
  useEffect(() => {
    return wsClient.on(EventType.CHARACTER_AVATAR_CHANGED, (payload: { chatId: string; characterId: string; imageId: string | null }) => {
      if (payload.characterId !== activeCharacterId) return

      // Invalidate cache so the next render cycle resamples
      const newImageId = payload.imageId ?? activeCharacter?.image_id ?? null
      const newKey = activeCharacterId ? `${activeCharacterId}:${newImageId ?? 'legacy'}` : null
      if (newKey) paletteCache.delete(newKey)

      // Reset applied refs to force both effects to re-run
      nameAppliedAvatarKeyRef.current = null
      appliedAvatarKeyRef.current = null

      // Trigger store update so the avatar URL deps change and effects re-fire
      useStore.getState().setActiveChatAvatarId(payload.imageId)
    })
  }, [activeCharacterId, activeCharacter?.image_id])
}
