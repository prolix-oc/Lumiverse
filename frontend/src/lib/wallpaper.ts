import type { WallpaperRef, WallpaperSettings } from '@/types/store'

/** Older settings and cleared mobile overrides fall back to the global wallpaper. */
export function resolveGlobalWallpaper(settings: WallpaperSettings, isMobile: boolean): WallpaperRef | null {
  return isMobile ? settings.mobile ?? settings.global : settings.global
}

export function getChatMobileWallpaper(metadata: Record<string, unknown> | null | undefined): WallpaperRef | null {
  const ref = metadata?.mobile_wallpaper
  if (!ref || typeof ref !== 'object') return null
  const { image_id, type } = ref as Partial<WallpaperRef>
  // ChatView's transition effect depends on this reference staying stable.
  return typeof image_id === 'string' && image_id && (type === 'image' || type === 'video')
    ? ref as WallpaperRef : null
}

/** Mobile chats inherit their regular wallpaper when no mobile override is assigned. */
export function resolveChatWallpaper(wallpaper: WallpaperRef | null, metadata: Record<string, unknown> | null | undefined, isMobile: boolean): WallpaperRef | null {
  return isMobile ? getChatMobileWallpaper(metadata) ?? wallpaper : wallpaper
}
