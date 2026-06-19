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
import { getCharacterAvatarThumbUrl, getCharacterAvatarThumbUrlById, pickCharacterThumbImageId } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import { extractPalette, type ImagePalette } from '@/lib/colorExtraction'
import { deriveCharacterOverlay, deriveCharacterNameVars } from '@/lib/characterTheme'
import { resolveMode } from '@/hooks/useThemeApplicator'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { ThemeConfig } from '@/types/theme'

/** In-memory palette cache keyed by avatar identity to avoid re-extraction. */
const paletteCache = new Map<string, ImagePalette>()

// ── Persisted palette layer ──
// Extraction means a thumb fetch + decode + pixel scan, and it can't even
// start until the character record is in the store — on a cold load that put
// the theme tint several round trips behind first paint. Persisting palettes
// (~1KB each) makes re-entry instantaneous. Map insertion order doubles as
// LRU order; bump PALETTE_CACHE_VERSION when ImagePalette's shape changes.
const PALETTE_CACHE_KEY = '__lumiverse_palette_cache'
const PALETTE_CACHE_VERSION = 1
const PALETTE_CACHE_MAX = 60

try {
  const stored = JSON.parse(localStorage.getItem(PALETTE_CACHE_KEY) || '')
  if (stored?.v === PALETTE_CACHE_VERSION && Array.isArray(stored.entries)) {
    for (const [key, palette] of stored.entries) {
      if (typeof key === 'string' && palette?.ui?.dark?.accent && palette?.dominant) {
        paletteCache.set(key, palette as ImagePalette)
      }
    }
  }
} catch { /* no usable cache — first run or private mode */ }

let palettePersistTimer: number | null = null
function schedulePalettePersist(): void {
  if (palettePersistTimer != null) return
  palettePersistTimer = window.setTimeout(() => {
    palettePersistTimer = null
    try {
      while (paletteCache.size > PALETTE_CACHE_MAX) {
        const oldest = paletteCache.keys().next().value
        if (oldest === undefined) break
        paletteCache.delete(oldest)
      }
      localStorage.setItem(
        PALETTE_CACHE_KEY,
        JSON.stringify({ v: PALETTE_CACHE_VERSION, entries: [...paletteCache.entries()] }),
      )
    } catch { /* quota/private mode — cache stays in-memory only */ }
  }, 250)
}

function getCachedPalette(key: string): ImagePalette | undefined {
  const hit = paletteCache.get(key)
  if (hit) {
    // Re-insert so frequently used palettes survive the LRU trim.
    paletteCache.delete(key)
    paletteCache.set(key, hit)
  }
  return hit
}

function setCachedPalette(key: string, palette: ImagePalette): void {
  paletteCache.set(key, palette)
  schedulePalettePersist()
}

/**
 * Fire-and-forget palette warm-up so chat entry finds the palette already
 * extracted (e.g. called from the landing page on chat click, in parallel
 * with the route change and chat fetch). No-op when character-aware theming
 * is off or the palette is already cached.
 */
export function warmCharacterPalette(
  characterId: string | null | undefined,
  imageId: string | null | undefined,
): void {
  if (!characterId) return
  const theme = useStore.getState().theme as ThemeConfig | null
  if (theme?.characterAware !== true) return
  const key = `${characterId}:${imageId ?? 'legacy'}`
  if (paletteCache.has(key)) return
  const url = getCharacterAvatarThumbUrlById(characterId, imageId)
  if (!url) return
  extractPalette(url)
    .then((palette) => setCachedPalette(key, palette))
    .catch(() => { /* warm-up is best-effort */ })
}

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
  const effectiveImageId = activeChatAvatarId ?? pickCharacterThumbImageId(activeCharacter) ?? null
  const avatarUrl = activeChatAvatarId
    ? imagesApi.smallUrl(activeChatAvatarId)
    : getCharacterAvatarThumbUrl(activeCharacter)
  const avatarCacheKey = activeCharacterId
    ? `${activeCharacterId}:${effectiveImageId ?? 'legacy'}`
    : null
  const appliedAvatarKeyRef = useRef<string | null>(null)
  const nameAppliedAvatarKeyRef = useRef<string | null>(null)
  // Monotonic request tokens. Every effect run bumps its counter; only the
  // latest run is allowed to write to the palette cache or to the store.
  // This protects against a slow extraction finishing after the user has
  // already switched characters (which would otherwise stamp the previous
  // character's palette onto the new one).
  const overlayRequestIdRef = useRef(0)
  const nameRequestIdRef = useRef(0)

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

    const myRequestId = ++nameRequestIdRef.current
    const isStale = () => myRequestId !== nameRequestIdRef.current

    const apply = async () => {
      try {
        let palette = getCachedPalette(avatarCacheKey)
        if (!palette) {
          const extracted = await extractPalette(avatarUrl)
          if (isStale()) return
          setCachedPalette(avatarCacheKey, extracted)
          palette = extracted
        }

        if (isStale()) return

        const vars = deriveCharacterNameVars(palette)
        for (const [key, value] of Object.entries(vars)) {
          root.style.setProperty(key, value)
        }
        nameAppliedAvatarKeyRef.current = avatarCacheKey
      } catch (err) {
        if (isStale()) return
        console.warn('[useCharacterTheme] Name color extraction failed:', err)
      }
    }

    apply()
    return () => { /* request id bump on next run supersedes this one */ }
  }, [characterAware, hasExtensionOverrides, activeCharacterId, avatarUrl, avatarCacheKey])

  // ── 2. Character-aware theme overlay (opt-in) ──
  // Suppressed when extension theme overrides are active — extensions take full
  // control of the palette, so character-derived accent/baseColors must yield.
  useEffect(() => {
    // Bump the request id for any state change. Synchronous early-return
    // branches still need to invalidate in-flight extractions so they don't
    // overwrite the freshly-cleared overlay.
    const myRequestId = ++overlayRequestIdRef.current
    const isStale = () => myRequestId !== overlayRequestIdRef.current

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

    const apply = async () => {
      try {
        let palette = getCachedPalette(avatarCacheKey)
        if (!palette) {
          const extracted = await extractPalette(avatarUrl)
          if (isStale()) return
          setCachedPalette(avatarCacheKey, extracted)
          palette = extracted
        }

        if (isStale()) return

        const overlay = deriveCharacterOverlay(palette)

        const current = useStore.getState().theme as ThemeConfig | null
        if (!current?.characterAware) return

        appliedAvatarKeyRef.current = avatarCacheKey
        setCharacterThemeOverlay(overlay)
      } catch (err) {
        // Only clear the overlay on a fresh failure — a stale failure must
        // not stomp on whatever the current request has (or will) apply.
        if (isStale()) return
        console.warn('[useCharacterTheme] Theme overlay failed:', err)
        setCharacterThemeOverlay(null)
        appliedAvatarKeyRef.current = null
      }
    }

    apply()
  }, [characterAware, hasExtensionOverrides, activeCharacterId, avatarUrl, avatarCacheKey, setCharacterThemeOverlay])

  // ── 3. React to CHARACTER_AVATAR_CHANGED — force resample ──
  useEffect(() => {
    return wsClient.on(EventType.CHARACTER_AVATAR_CHANGED, (payload: { chatId: string; characterId: string; imageId: string | null }) => {
      if (payload.characterId !== activeCharacterId) return

      // Invalidate cache so the next render cycle resamples
      const newImageId = payload.imageId ?? activeCharacter?.image_id ?? null
      const newKey = activeCharacterId ? `${activeCharacterId}:${newImageId ?? 'legacy'}` : null
      if (newKey && paletteCache.delete(newKey)) schedulePalettePersist()

      // Reset applied refs to force both effects to re-run
      nameAppliedAvatarKeyRef.current = null
      appliedAvatarKeyRef.current = null
      setCharacterThemeOverlay(null)

      // Trigger store update so the avatar URL deps change and effects re-fire
      useStore.getState().setActiveChatAvatarId(payload.imageId)
    })
  }, [activeCharacterId, activeCharacter?.image_id, setCharacterThemeOverlay])
}
