/**
 * Two responsibilities, both opt-in via `characterAware: true` on the theme:
 *
 * 1. **Character name colors**: Extracts a palette from the active character's
 *    avatar and sets `--char-name-dark` / `--char-name-light` on the root.
 *    Without characterAware (or with extension overrides), these are removed
 *    so CSS falls back to `--lumiverse-primary-text` (white/black per mode).
 *
 * 2. **Character-aware theme overlay**: Merges accent + base colors derived
 *    from the avatar onto the current theme.
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
  const setCharacterThemeOverlay = useStore((s) => s.setCharacterThemeOverlay)
  const hasExtensionOverrides = useStore((s) =>
    Object.keys(s.extensionThemeOverrides).some((id) => !s.mutedExtensionThemes[id])
  )
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

  // ── 1. Character name colors (opt-in via characterAware) ──
  useEffect(() => {
    const root = document.documentElement

    // Only derive name colors when characterAware is enabled and no extension
    // overrides are active. Otherwise the CSS fallback (--lumiverse-primary-text)
    // applies — white in dark mode, black in light mode.
    if (!characterAware || hasExtensionOverrides || !activeCharacterId || !avatarUrl || !avatarCacheKey) {
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
  }, [characterAware, hasExtensionOverrides, activeCharacterId, avatarUrl, avatarCacheKey])

  // ── 2. Character-aware theme overlay (opt-in) ──
  // Suppressed when extension theme overrides are active — extensions take full
  // control of the palette, so character-derived accent/baseColors must yield.
  useEffect(() => {
    if (!characterAware || hasExtensionOverrides) {
      setCharacterThemeOverlay(null)
      appliedAvatarKeyRef.current = null
      return
    }

    if (!activeCharacterId || !avatarUrl || !avatarCacheKey) {
      setCharacterThemeOverlay(null)
      appliedAvatarKeyRef.current = null
      return
    }
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
        setCharacterThemeOverlay(overlay)
      } catch (err) {
        setCharacterThemeOverlay(null)
        appliedAvatarKeyRef.current = null
        console.warn('[useCharacterTheme] Theme overlay failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [characterAware, hasExtensionOverrides, activeCharacterId, avatarUrl, avatarCacheKey, setCharacterThemeOverlay])

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
      setCharacterThemeOverlay(null)

      // Trigger store update so the avatar URL deps change and effects re-fire
      useStore.getState().setActiveChatAvatarId(payload.imageId)
    })
  }, [activeCharacterId, activeCharacter?.image_id, setCharacterThemeOverlay])
}
