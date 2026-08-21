import { DEFAULT_LANDING_PAGE_TAB, isLandingPageTab, type LandingPageTab } from './landingPageTabs'

export const DEVICE_LANDING_PAGE_START_TAB_STORAGE_KEY = 'lumiverse:device:landing-page-start-tab'

function storageKey(userId: string): string {
  return `${DEVICE_LANDING_PAGE_START_TAB_STORAGE_KEY}:${userId}`
}

/** Read the per-device start preference. Guests and unavailable storage use Characters. */
export function readDeviceLandingPageStartTab(userId: string | null | undefined): LandingPageTab {
  if (!userId) return DEFAULT_LANDING_PAGE_TAB
  try {
    const value = localStorage.getItem(storageKey(userId))
    return isLandingPageTab(value) ? value : DEFAULT_LANDING_PAGE_TAB
  } catch {
    return DEFAULT_LANDING_PAGE_TAB
  }
}

/** Save the start preference locally; it is never sent through account settings. */
export function writeDeviceLandingPageStartTab(
  userId: string | null | undefined,
  tab: LandingPageTab,
): void {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), tab)
  } catch {
    // The current session still works if browser storage is unavailable.
  }
}
