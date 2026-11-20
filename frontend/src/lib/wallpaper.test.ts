import { describe, expect, test } from 'bun:test'
import type { WallpaperSettings } from '@/types/store'
import { getChatMobileWallpaper, resolveChatWallpaper, resolveGlobalWallpaper } from './wallpaper'

const global = { image_id: 'desktop-landscape', type: 'image' as const }
const mobile = { image_id: 'mobile-portrait', type: 'image' as const }
const settings: WallpaperSettings = { global, mobile, opacity: 0.3, fit: 'cover', blur: 0 }

describe('device wallpaper selection', () => {
  test('uses the independent mobile override only on mobile', () => {
    expect(resolveGlobalWallpaper(settings, true)).toEqual(mobile)
    expect(resolveGlobalWallpaper(settings, false)).toEqual(global)
  })
  test('falls back for legacy settings and cleared overrides', () => {
    expect(resolveGlobalWallpaper({ ...settings, mobile: undefined }, true)).toEqual(global)
    expect(resolveGlobalWallpaper({ ...settings, mobile: null }, true)).toEqual(global)
    expect(resolveGlobalWallpaper({ ...settings, global: null, mobile: null }, true)).toBeNull()
  })
  test('allows a mobile-only video without enabling a desktop background', () => {
    const video = { image_id: 'mobile-video', type: 'video' as const }
    expect(resolveGlobalWallpaper({ ...settings, global: null, mobile: video }, true)).toEqual(video)
    expect(resolveGlobalWallpaper({ ...settings, global: null, mobile: video }, false)).toBeNull()
  })
})

describe('chat mobile wallpapers', () => {
  test('selects the mobile chat override without changing the desktop chat wallpaper', () => {
    const metadata = { mobile_wallpaper: mobile, topic: 'keep' }
    expect(resolveChatWallpaper(global, metadata, true)).toEqual(mobile)
    expect(resolveChatWallpaper(global, metadata, false)).toEqual(global)
    expect(resolveChatWallpaper(null, metadata, true)).toEqual(mobile)
    expect(resolveChatWallpaper(null, metadata, false)).toBeNull()
  })
  test('inherits the regular chat wallpaper when missing, cleared or malformed', () => {
    for (const metadata of [null, {}, { mobile_wallpaper: null }, { mobile_wallpaper: { image_id: '', type: 'image' } }, { mobile_wallpaper: { image_id: 'bad', type: 'other' } }]) {
      expect(resolveChatWallpaper(global, metadata, true)).toEqual(global)
      expect(resolveChatWallpaper(null, metadata, true)).toBeNull()
    }
  })
  test('supports mobile chat video wallpapers', () => {
    const video = { image_id: 'chat-video', type: 'video' as const }
    expect(getChatMobileWallpaper({ mobile_wallpaper: video })).toEqual(video)
  })
  test('keeps the wallpaper reference stable across renders and unrelated metadata changes', () => {
    expect(getChatMobileWallpaper({ mobile_wallpaper: mobile })).toBe(mobile)
    expect(resolveChatWallpaper(global, { mobile_wallpaper: mobile, topic: 'updated' }, true)).toBe(mobile)
  })
})
