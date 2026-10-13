import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { initI18n } from '@/i18n'
import { registerSW } from 'virtual:pwa-register'
import { getSafeInAppNavigationUrl } from './lib/navigationSafety'
import { installWindowOpenGuard } from './lib/windowOpenGuard'
import { computeViewportKeyboardInset } from './lib/viewportKeyboardInset'
import { usesNativeWidgetTouchScroll } from './lib/spindle/widget-touch-scroll'
import { installKeyboardFocusReveal } from './lib/keyboardFocusReveal'
import { installIOSKeyboardScrollGuard } from './lib/iosKeyboardScroll'
import { installIOSEditableFocusScrollPrevention } from './lib/iosEditableFocus'
import { rememberRegistration } from './lib/swUpdater'
import { claimServiceWorkerReload } from './lib/swUpdatePolicy'
import { installPwaLifecycleDiagnostics } from './lib/pwaLifecycleDiagnostics'
import { initializeSafeThemeMode } from './lib/safeThemeMode'
import { installDisplayPerformanceTelemetry, markDisplayInteractive, markDisplayMilestone } from './lib/displayPerformance'
import { router } from './router'
import { installStreamDeckHandoffReceiver } from './lib/streamDeckHandoff'
import ErrorBoundary from './components/shared/ErrorBoundary'
import './theme/variables.css'
import './theme/reset.css'
import './theme/global.css'

installDisplayPerformanceTelemetry('application')
installWindowOpenGuard()
installPwaLifecycleDiagnostics()
installStreamDeckHandoffReceiver(path => { void router.navigate(path) })

let reloading = false

// Register service worker for PWA support — autoUpdate sends SKIP_WAITING
// automatically when a new SW is detected.
registerSW({
  immediate: true,
  // vite-plugin-pwa calls this only after an updated (including externally
  // updated) worker takes control. Keep the reload policy with the
  // registration lifecycle instead of duplicating it with a browser listener.
  onNeedReload() {
    if (reloading) return
    if (!claimServiceWorkerReload(window.sessionStorage)) {
      console.warn('[service-worker] Suppressed repeated automatic reload')
      return
    }
    reloading = true
    window.location.reload()
  },
  onRegisteredSW(_swUrl, registration) {
    // Long-running tabs (especially PWAs) may stay open for days.
    // Periodically check for a new SW so deploys are picked up without
    // requiring a navigation or manual refresh.
    if (registration) {
      setInterval(() => {
        if (document.visibilityState === 'visible') registration.update()
      }, 60 * 60 * 1000)
    }
    // Hand the registration to swUpdater so the connection-lost overlay can
    // ask for an immediate bundle check on reconnect, and so we can surface
    // an "Updating…" state when a new worker is installing.
    rememberRegistration(registration)
  },
})

// Navigate when a push notification is clicked (SW posts NAVIGATE message)
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'NAVIGATE') {
    router.navigate(getSafeInAppNavigationUrl(event.data.url))
  }
})

// ── Virtual-keyboard-aware viewport tracking ──
// The on-screen keyboard is the only thing that introduces a bottom inset, and
// it can only appear while an editable element is focused. iOS 26/27 ships a
// regression (WebKit #297779 / FB19889436) where visualViewport.height and
// .offsetTop stay STUCK after the keyboard is dismissed — so we must not infer
// "keyboard gone" from those numbers. We gate on focus state instead, and track
// the no-keyboard baseline as a per-orientation max so a stuck reduced height
// can never poison it.
const hasVirtualKeyboard = navigator.maxTouchPoints > 0
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
// Real soft keyboards are >150px tall in portrait, >100px in landscape. Treat
// anything below this floor as an iOS viewport glitch (the stuck ~24px
// residual), not a keyboard — prevents the input bar floating by a sliver.
const KEYBOARD_MIN_INSET = 80
// Hardware-keyboard focus on iPadOS can still show the compact input assistant
// / autocomplete pill. It's much smaller than a soft keyboard, but still
// occludes the bottom controls enough to trigger scroll bounce if ignored.
const IOS_PWA_ACCESSORY_MIN_INSET = 44
const isIOSStandalonePwa = (window.navigator as any).standalone === true && navigator.maxTouchPoints > 0

function isEditableElement(el: EventTarget | Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

// Source of truth for keyboard visibility — driven by focusin/focusout below,
// NOT by visualViewport deltas (which iOS 26/27 reports unreliably).
let keyboardOpen = false

// Per-orientation no-keyboard baseline = the MAX visual viewport height we've
// observed with the keyboard closed, in that orientation. We never shrink it:
// iOS 26/27 leaves visualViewport.height stuck at the keyboard-reduced value
// after a dismissal, so the live height while "closed" can't be trusted — only
// the largest genuine height we've seen. Keyed by orientation because the full
// height differs between portrait and landscape.
const initialFullHeight = window.visualViewport
  ? window.visualViewport.height * window.visualViewport.scale
  : window.innerHeight
const startedPortrait = window.matchMedia('(orientation: portrait)').matches
let basePortrait = startedPortrait ? initialFullHeight : 0
let baseLandscape = startedPortrait ? 0 : initialFullHeight

function syncViewportVars() {
  const root = document.documentElement
  const viewport = window.visualViewport
  // Pinch zoom changes the visible region, not the app's layout size.
  // Normalize dimensions so zoom isn't mistaken for a keyboard opening.
  const scale = viewport?.scale ?? 1
  const zoomed = Math.abs(scale - 1) > 0.01
  const width = Math.round(viewport ? viewport.width * scale : window.innerWidth)
  const height = Math.round(viewport ? viewport.height * scale : window.innerHeight)
  const offsetTop = zoomed ? 0 : Math.round(viewport?.offsetTop ?? 0)
  const offsetLeft = zoomed ? 0 : Math.round(viewport?.offsetLeft ?? 0)

  const keyboardActive = hasVirtualKeyboard && keyboardOpen
  // Grow the baseline only from keyboard-closed readings — a closed viewport
  // can't be shorter than full, so this converges to the true height and locks.
  // Never grow it while the keyboard is up (that would bake a transient over-read
  // into the baseline and float the bar) and never shrink it (a stuck reduced
  // height after dismissal must not poison it). Use matchMedia for orientation,
  // not the viewport aspect ratio — a tall keyboard can make height < width.
  const isPortrait = window.matchMedia('(orientation: portrait)').matches
  let base = isPortrait ? basePortrait : baseLandscape
  if (!keyboardActive && height > base) base = height
  if (isPortrait) basePortrait = base
  else baseLandscape = base

  // Standalone iOS composers prevent native focus scrolling, and the guard
  // below recovers real document scrolling. WebKit can still report transient
  // or stale offsetTop values; do not subtract those from keyboard clearance.
  const keyboardInsetBottom = computeViewportKeyboardInset({
    fullHeight: base,
    viewportHeight: height,
    offsetTop,
    keyboardActive,
    ignoreOffsetTop: isIOSStandalonePwa,
    keyboardMinInset: KEYBOARD_MIN_INSET,
    accessoryMinInset: isIOSStandalonePwa ? IOS_PWA_ACCESSORY_MIN_INSET : KEYBOARD_MIN_INSET,
  })

  root.style.setProperty('--app-viewport-width', `${width}px`)
  root.style.setProperty('--app-viewport-height', `${height}px`)
  root.style.setProperty('--app-viewport-offset-top', `${offsetTop}px`)
  root.style.setProperty('--app-viewport-offset-left', `${offsetLeft}px`)
  root.style.setProperty('--app-visual-viewport-width', `${Math.round(viewport?.width ?? window.innerWidth)}px`)
  root.style.setProperty('--app-visual-viewport-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`)
  root.style.setProperty('--app-visual-viewport-offset-top', `${Math.round(viewport?.offsetTop ?? 0)}px`)
  root.style.setProperty('--app-visual-viewport-offset-left', `${Math.round(viewport?.offsetLeft ?? 0)}px`)
  root.style.setProperty('--app-keyboard-inset-bottom', `${keyboardInsetBottom}px`)
  root.style.setProperty('--app-screen-height', `${Math.round(window.innerHeight)}px`)
}

let viewportSyncFrame = 0

function scheduleViewportSync() {
  // Coalesce multiple resize notifications into one update per paint rather
  // than debouncing them. macOS emits a rapid stream while its native zoom
  // animation runs; cancelling the pending frame on every notification left
  // our viewport-dependent layouts at their old dimensions until the zoom
  // completed.
  if (viewportSyncFrame) return
  viewportSyncFrame = window.requestAnimationFrame(() => {
    viewportSyncFrame = 0
    syncViewportVars()
  })
}

scheduleViewportSync()
window.addEventListener('resize', scheduleViewportSync, { passive: true })
window.addEventListener('orientationchange', () => {
  // Re-sync once the rotation settles. We deliberately do NOT force-recapture
  // the baseline here: rotation does not reliably dismiss the keyboard on iOS
  // 26/27, and capturing a keyboard-reduced height as the baseline was exactly
  // what left the bar unable to clear the keyboard after a rotation. The
  // focus-gated, self-healing baseline in syncViewportVars handles it instead.
  setTimeout(scheduleViewportSync, 300)
}, { passive: true })
window.visualViewport?.addEventListener('resize', scheduleViewportSync)
window.visualViewport?.addEventListener('scroll', scheduleViewportSync)

// ── Keyboard visibility tracking (focus-driven) ──
// Tie keyboard open/close to focus rather than viewport deltas. iOS fires
// focusout→focusin when moving between fields, so debounce the close and
// re-check document.activeElement before declaring the keyboard gone.
let keyboardBlurTimer = 0
document.addEventListener('focusin', (e) => {
  if (!isEditableElement(e.target)) return
  clearTimeout(keyboardBlurTimer)
  if (!keyboardOpen) {
    keyboardOpen = true
    scheduleViewportSync()
  }
}, { passive: true })
document.addEventListener('focusout', () => {
  clearTimeout(keyboardBlurTimer)
  keyboardBlurTimer = window.setTimeout(() => {
    if (isEditableElement(document.activeElement)) return
    keyboardOpen = false
    scheduleViewportSync()
  }, 120)
}, { passive: true })

// Utility: walk up the DOM to find the nearest ancestor that is currently
// scrollable (has overflow AND content exceeds container). Used by the
// overscroll prevention touch handler. Returns the element and whether it
// scrolls horizontally (so the touch handler can let horizontal swipes through).
function findScrollableAncestor(el: HTMLElement | null): { el: HTMLElement; horizontal: boolean } | null {
  while (el && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el)
    const scrollableY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
    const scrollableX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
    if (scrollableY || scrollableX) {
      return { el, horizontal: scrollableX && !scrollableY }
    }
    el = el.parentElement
  }
  return null
}

// Composers and editors prevent native focus from panning the whole shell.
// Fields retain native caret placement; their scroll containers own revealing.
// Recover only real document scrolling, without resetting stale viewport offsets.
if (isIOSStandalonePwa) {
  installIOSEditableFocusScrollPrevention()
  installIOSKeyboardScrollGuard()
}

// Flag standalone PWA mode for CSS targeting.
// Check both matchMedia (Chromium/Android) and navigator.standalone (iOS Safari)
// since iOS PWA shells may not advertise display-mode: standalone via CSS.
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: window-controls-overlay)').matches ||
  (window.navigator as any).standalone === true

if (/^Mac/.test(navigator.platform) && navigator.maxTouchPoints === 0) {
  document.documentElement.setAttribute('data-platform', 'macos')
} else if (/^Linux/.test(navigator.platform)) {
  document.documentElement.setAttribute('data-platform', 'linux')
}

// iPadOS can identify itself as macOS, so use both the iOS user-agent and
// touch-capable MacIntel checks. Mobile editor surfaces use this to reserve
// only the status-bar area without shrinking their full-screen frame.
if (isIOS) {
  document.documentElement.setAttribute('data-ios', '')
}

// Mark the native dashboard WebView for desktop-specific behavior. The Tauri
// window is frameless on every desktop platform, so the HTML titlebar owns its
// drag surface and window controls outside browser PWA display-mode queries.
if ('__TAURI_INTERNALS__' in window) {
  document.documentElement.setAttribute('data-tauri-desktop', '')
  if (new URLSearchParams(window.location.search).has('desktopWidgetExtension')) {
    document.documentElement.setAttribute('data-tauri-floating-widget', '')
  }
}

if (isStandalone) {
  document.documentElement.setAttribute('data-pwa', '')
  // Tag iOS/iPadOS PWAs separately — position:fixed + inset:0 triggers WebKit
  // bug #237961 (bottom gap with viewport-fit=cover). The standalone
  // media query now matches on iOS 16.4+, so we need an attribute to
  // exclude iOS from the Chromium-only position:fixed workaround.
  // Guard with maxTouchPoints > 0 to exclude macOS Safari "Add to Dock" apps,
  // which also set navigator.standalone but need the position:fixed sizing path.
  // (iOS/iPadOS: maxTouchPoints=5, macOS: maxTouchPoints=0)
  if ((window.navigator as any).standalone === true && navigator.maxTouchPoints > 0) {
    document.documentElement.setAttribute('data-ios-pwa', '')

    // Set the true physical screen height via JS. CSS env(safe-area-inset-top)
    // and viewport units are unreliable across iOS versions for sizing the
    // app shell. screen.height is the actual device screen in CSS pixels —
    // it never changes with keyboard, safe areas, or viewport-fit mode.
    const syncScreenHeight = () => {
      const isPortrait = window.matchMedia('(orientation: portrait)').matches
      const h = isPortrait ? screen.height : screen.width
      document.documentElement.style.setProperty('--ios-screen-height', `${h}px`)
    }
    syncScreenHeight()
    window.addEventListener('orientationchange', syncScreenHeight, { passive: true })
  }
}

// Add interactive-widget=resizes-content on non-WebKit browsers only.
// Safari/WebKit ignores this attribute, and its presence may interfere
// with viewport calculations on iOS/iPadOS PWAs. Detect WebKit by engine
// rather than device — iOS/iPadOS Safari now reports as macOS in the UA.
const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)

if (!isWebKit) {
  document.documentElement.setAttribute('data-resizes-content', '')
  const viewport = document.querySelector('meta[name="viewport"]')
  if (viewport) {
    viewport.setAttribute('content', viewport.getAttribute('content') + ', interactive-widget=resizes-content')
  }
}

// Always suppress the browser's page zoom. The optional desktop controller
// handles these same events when enabled; native page zoom breaks app layout.
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false })
document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false })
document.addEventListener('touchmove', (event) => {
  if (event.touches.length > 1) event.preventDefault()
}, { passive: false })

// Keep native desktop page zoom suppressed, including when the optional
// viewport zoom setting is off. The controller handles ctrl-wheel when on.
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault()
}, { passive: false })

// ── iOS PWA: prevent overscroll snap-back and body scroll ──
// Two WebKit bugs cause scrolling issues in standalone mode:
// 1. Overscroll chaining — touching the boundary of a scroll container causes
//    the entire PWA to rubber-band, snapping back and making bottom content
//    in panels/modals unreachable.
// 2. Bug #240860 — body with overflow:hidden becomes scrollable when the
//    visual viewport is smaller than the layout viewport (keyboard open),
//    causing scroll containers to fight with body scroll.
// Fix: intercept single-finger touchmove at document level. Allow scrolling
// within scrollable containers, but prevent the default (which triggers
// page-level overscroll) at scroll boundaries and outside scroll containers.
if ((window.navigator as any).standalone === true && navigator.maxTouchPoints > 0) {
  let touchStartY = 0
  let touchStartX = 0
  let scrollTarget: { el: HTMLElement; horizontal: boolean } | null = null

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchStartY = e.touches[0].clientY
      touchStartX = e.touches[0].clientX
      scrollTarget = findScrollableAncestor(e.target as HTMLElement)
    }
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return
    // Only an explicitly opted-in live widget owns its single-finger scrolling.
    if (usesNativeWidgetTouchScroll(e)) return
    // Let the browser pan the magnified page.
    if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01) return

    const deltaY = touchStartY - e.touches[0].clientY
    const deltaX = touchStartX - e.touches[0].clientX

    // Don't interfere with horizontal scrolling (carousels, tab bars, sliders)
    if (Math.abs(deltaX) > Math.abs(deltaY) + 5) return

    // Touch started inside a horizontal-only scroll container — let it through
    if (scrollTarget?.horizontal) return

    if (scrollTarget) {
      const { el } = scrollTarget
      const atTop = el.scrollTop <= 0 && deltaY < 0
      const atBottom =
        el.scrollTop + el.clientHeight >=
        el.scrollHeight - 1 && deltaY > 0
      if (atTop || atBottom) e.preventDefault()
    } else {
      e.preventDefault()
    }
  }, { passive: false })

  // Ordinary fields need ancestor scrolling because PWA viewport panning is
  // suppressed. Bounded editors retain native caret/scroll ownership.
  installKeyboardFocusReveal()
}

// ── Mobile layout recovery after native popups / backgrounding ──
// iOS/Android can leave position:fixed/sticky elements shifted after system
// file pickers, share sheets, or backgrounding. Blur any focused editable
// control, reset every scroll path the browser may have panned, and re-sync
// viewport measurements so the app shell snaps back to the viewport.
if (navigator.maxTouchPoints > 0) {
  function blurActiveEditable() {
    if (isEditableElement(document.activeElement)) {
      ;(document.activeElement as HTMLElement).blur()
    }
  }

  function recoverMobileLayout() {
    blurActiveEditable()
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0
    scheduleViewportSync()
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) blurActiveEditable()
    else recoverMobileLayout()
  })

  window.addEventListener('pagehide', blurActiveEditable)
  window.addEventListener('pageshow', recoverMobileLayout)
  window.addEventListener('focus', recoverMobileLayout)
  // Allow code paths that know a system popup just closed (e.g. file inputs)
  // to request an explicit recovery even if no page-visibility event fired.
  window.addEventListener('lumiverse:recover-mobile-layout', recoverMobileLayout)
}

void Promise.all([initI18n(), initializeSafeThemeMode()]).then(() => {
  markDisplayMilestone('render-scheduled')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary label="Application">
        <RouterProvider router={router} />
      </ErrorBoundary>
    </StrictMode>,
  )
  markDisplayInteractive()
})
