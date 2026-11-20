import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

export interface DuoRect { x: number; y: number; width: number; height: number }
export interface IOSReservedRegion extends DuoRect { isActive: boolean }
export interface IOSLayoutSnapshot {
  version: 1
  revision: number
  width: number
  height: number
  horizontalSizeClass: number
  verticalSizeClass: number
  hingeStatus: string
  /** Native hinge capability, retained on the outer display while folded. */
  isFoldable?: boolean
  safeArea: { top: number; right: number; bottom: number; left: number }
  divisions: IOSReservedRegion[]
  occlusions: IOSReservedRegion[]
}
export interface DuoLayout {
  axis: 'horizontal' | 'vertical'
  chat: DuoRect
  drawer: DuoRect
  width: number
  height: number
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
function isRect(value: unknown): value is IOSReservedRegion {
  if (!value || typeof value !== 'object') return false
  const r = value as IOSReservedRegion
  return [r.x, r.y, r.width, r.height].every(finite) && r.width >= 0 && r.height >= 0 && typeof r.isActive === 'boolean'
}
export function isIOSLayoutSnapshot(value: unknown): value is IOSLayoutSnapshot {
  if (!value || typeof value !== 'object') return false
  const s = value as IOSLayoutSnapshot
  return s.version === 1 && finite(s.revision) && finite(s.width) && s.width > 0 && finite(s.height) && s.height > 0
    && (s.isFoldable === undefined || typeof s.isFoldable === 'boolean')
    && !!s.safeArea && [s.safeArea.top, s.safeArea.right, s.safeArea.bottom, s.safeArea.left].every(v => finite(v) && v >= 0)
    && Array.isArray(s.divisions) && s.divisions.every(isRect) && Array.isArray(s.occlusions) && s.occlusions.every(isRect)
}

/** Prefer the native capability, with native hinge geometry for older wrappers. */
export function isIOSFoldable(layout: IOSLayoutSnapshot | null): boolean {
  return !!layout && (layout.isFoldable ?? (['closed', 'partiallyOpen', 'fullyOpen'].includes(layout.hingeStatus) || layout.divisions.length > 0))
}

/** Initial snapshot + live changes, including protection against a stale startup reply. */
export function subscribeIOSLayout(onLayout: (layout: IOSLayoutSnapshot) => void): () => void {
  if (!hasIOSNativeBridge()) return () => {}
  let stopped = false
  let revision = -1
  const accept = (value: unknown) => {
    if (!stopped && isIOSLayoutSnapshot(value) && value.revision >= revision) {
      revision = value.revision
      onLayout(value)
    }
  }
  const receive = (event: Event) => accept((event as CustomEvent).detail)
  const refresh = () => { void iosNativeRequest('layout.status').then(accept).catch(() => {}) }
  window.addEventListener('lumiverse:ios-layout', receive)
  window.addEventListener('pageshow', refresh)
  window.addEventListener('focus', refresh)
  refresh()
  return () => {
    stopped = true
    window.removeEventListener('lumiverse:ios-layout', receive)
    window.removeEventListener('pageshow', refresh)
    window.removeEventListener('focus', refresh)
  }
}

function avoidOcclusions(rect: DuoRect, occlusions: IOSReservedRegion[]): DuoRect {
  let result = rect
  for (const o of occlusions) {
    if (!o.isActive || o.x >= result.x + result.width || o.x + o.width <= result.x
      || o.y >= result.y + result.height || o.y + o.height <= result.y) continue
    // Keep the largest unobscured rectangle. Camera regions already include margins.
    const right = result.x + result.width, bottom = result.y + result.height
    const candidates = [
      { ...result, width: o.x - result.x },
      { ...result, x: o.x + o.width, width: right - o.x - o.width },
      { ...result, height: o.y - result.y },
      { ...result, y: o.y + o.height, height: bottom - o.y - o.height },
    ].filter(r => r.width > 0 && r.height > 0)
    result = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? { ...result, width: 0, height: 0 }
  }
  return result
}

/** Only a divider that crosses this window can create two persistent panes. */
export function resolveDuoLayout(snapshot: IOSLayoutSnapshot | null, drawerSide: 'left' | 'right', scale = 1): DuoLayout | null {
  if (!snapshot || !isIOSLayoutSnapshot(snapshot) || snapshot.hingeStatus === 'closed') return null
  const { width, height, safeArea: s } = snapshot
  const right = width - s.right, bottom = height - s.bottom
  const usable = { x: s.left, y: s.top, width: right - s.left, height: bottom - s.top }
  const uiScale = finite(scale) && scale > 0 ? scale : 1
  for (const fold of snapshot.divisions) {
    let first: DuoRect, second: DuoRect, axis: DuoLayout['axis']
    if (fold.y <= usable.y && fold.y + fold.height >= bottom && fold.x > usable.x && fold.x + fold.width < right) {
      axis = 'horizontal'
      first = { ...usable, width: fold.x - usable.x }
      second = { ...usable, x: fold.x + fold.width, width: right - fold.x - fold.width }
    } else if (fold.x <= usable.x && fold.x + fold.width >= right && fold.y > usable.y && fold.y + fold.height < bottom) {
      axis = 'vertical'
      first = { ...usable, height: fold.y - usable.y }
      second = { ...usable, y: fold.y + fold.height, height: bottom - fold.y - fold.height }
    } else continue
    first = avoidOcclusions(first, snapshot.occlusions)
    second = avoidOcclusions(second, snapshot.occlusions)
    if ([first, second].some(r => r.width / uiScale < 280 || r.height / uiScale < 220)) continue
    const drawerFirst = axis === 'horizontal' && drawerSide === 'left'
    return { axis, chat: drawerFirst ? second : first, drawer: drawerFirst ? first : second, width, height }
  }
  return null
}

export function duoPaneStyle(rect: DuoRect, layout: Pick<DuoLayout, 'width' | 'height'>) {
  return {
    left: `${rect.x / layout.width * 100}%`, top: `${rect.y / layout.height * 100}%`,
    width: `${rect.width / layout.width * 100}%`, height: `${rect.height / layout.height * 100}%`,
  }
}

export function duoChatStyle(layout: DuoLayout) {
  return {
    ...duoPaneStyle(layout.chat, layout),
    '--app-keyboard-inset-bottom': `max(0px, calc(var(--duo-window-keyboard-inset-bottom, 0px) - ${(layout.height - layout.chat.y - layout.chat.height) / layout.height * 100}dvh))`,
  }
}
