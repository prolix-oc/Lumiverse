import { useMemo } from 'react'

/**
 * Maps iPhone screen dimensions (CSS px) to display corner radii (CSS px).
 * Sourced from the ScreenCorners library by Kyle Bashour.
 * When multiple models share a viewport, the most common/newest radius is used.
 */
const IPHONE_SCREEN_MAP: Array<{ w: number; h: number; dpr: number; radius: number }> = [
  { w: 375, h: 812, dpr: 3, radius: 44 },   // X, Xs, 11 Pro, 12 mini, 13 mini
  { w: 414, h: 896, dpr: 2, radius: 41.5 },  // XR, 11
  { w: 414, h: 896, dpr: 3, radius: 39 },    // Xs Max, 11 Pro Max
  { w: 390, h: 844, dpr: 3, radius: 47.33 }, // 12, 12 Pro, 13, 13 Pro, 14, 16, 16e
  { w: 428, h: 926, dpr: 3, radius: 53.33 }, // 12 Pro Max, 13 Pro Max, 14 Plus, 16 Plus
  { w: 393, h: 852, dpr: 3, radius: 55 },    // 14 Pro, 15, 15 Pro, 16 Pro
  { w: 430, h: 932, dpr: 3, radius: 55 },    // 14 Pro Max, 15 Plus, 15 Pro Max
  { w: 402, h: 874, dpr: 3, radius: 62 },    // 17, 17 Pro
  { w: 420, h: 912, dpr: 3, radius: 62 },    // 17 Air
  { w: 440, h: 956, dpr: 3, radius: 62 },    // 17 Pro Max
]

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone/.test(navigator.userAgent) && /WebKit/.test(navigator.userAgent)
}

function getScreenCornerRadius(): number | null {
  if (!isIOS()) return null

  // Use portrait dimensions regardless of current orientation
  const sw = Math.min(screen.width, screen.height)
  const sh = Math.max(screen.width, screen.height)
  const dpr = window.devicePixelRatio

  const match = IPHONE_SCREEN_MAP.find(
    (entry) => entry.w === sw && entry.h === sh && Math.abs(entry.dpr - dpr) < 0.5
  )

  // Fallback for unrecognized future iPhones — all Face ID models have ≥375px width
  // 55px is the most common radius across the current iPhone lineup
  if (!match) return 55

  return match.radius
}

/**
 * Detects iPhone model via screen dimensions + user agent and returns
 * the device display's corner radius in CSS pixels, suitable for use
 * as the bottom border-radius of a floating input bar.
 *
 * Returns null on non-iPhone devices.
 */
export function useDeviceFrameRadius(): number | null {
  return useMemo(() => getScreenCornerRadius(), [])
}
