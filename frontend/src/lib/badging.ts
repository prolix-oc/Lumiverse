const isSupported = typeof navigator !== 'undefined' && 'setAppBadge' in navigator

export function isBadgeSupported(): boolean {
  return isSupported
}

export function setBadge(count: number): void {
  if (!isSupported) return
  if (count <= 0) {
    clearBadge()
    return
  }
  navigator.setAppBadge(count).catch(() => {})
}

export function clearBadge(): void {
  if (!isSupported) return
  navigator.clearAppBadge().catch(() => {})
}
