import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import { router } from './router'
import './theme/variables.css'
import './theme/reset.css'
import './theme/global.css'

// Register service worker for PWA support — autoUpdate sends SKIP_WAITING
// automatically when a new SW is detected.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    // Long-running tabs (especially PWAs) may stay open for days.
    // Periodically check for a new SW so deploys are picked up without
    // requiring a navigation or manual refresh.
    if (registration) {
      setInterval(() => { registration.update() }, 60 * 60 * 1000)
    }
  },
})

// Auto-reload when a new service worker takes control after a deploy.
// The new SW calls clients.claim(), firing this event on all open tabs.
// Guard: skip on first install (no previous controller) to avoid a
// pointless reload when the user visits for the very first time.
let reloading = false
const hadController = !!navigator.serviceWorker?.controller
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (!hadController || reloading) return
  reloading = true
  window.location.reload()
})

// Navigate when a push notification is clicked (SW posts NAVIGATE message)
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'NAVIGATE') {
    router.navigate(event.data.url)
  }
})

// Capture the no-keyboard viewport height at load time. On iOS PWA,
// window.innerHeight may shrink with the keyboard (same as visualViewport),
// making it useless as a reference. This value is recaptured on orientation
// change (which dismisses the keyboard).
let baseViewportHeight = window.visualViewport?.height ?? window.innerHeight

function syncViewportVars() {
  const root = document.documentElement
  const viewport = window.visualViewport
  const width = Math.round(viewport?.width ?? window.innerWidth)
  const height = Math.round(viewport?.height ?? window.innerHeight)
  const offsetTop = Math.round(viewport?.offsetTop ?? 0)
  const offsetLeft = Math.round(viewport?.offsetLeft ?? 0)

  // Track the largest visualViewport.height we've seen — this is the
  // no-keyboard height. It self-corrects on orientation change.
  if (height > baseViewportHeight) baseViewportHeight = height

  const keyboardInsetBottom = Math.max(0, Math.round(baseViewportHeight - height - offsetTop))

  root.style.setProperty('--app-viewport-width', `${width}px`)
  root.style.setProperty('--app-viewport-height', `${height}px`)
  root.style.setProperty('--app-viewport-offset-top', `${offsetTop}px`)
  root.style.setProperty('--app-viewport-offset-left', `${offsetLeft}px`)
  root.style.setProperty('--app-keyboard-inset-bottom', `${keyboardInsetBottom}px`)
  root.style.setProperty('--app-screen-height', `${Math.round(window.innerHeight)}px`)

  // Compensate --app-shell-height for CSS zoom on body. Inside the zoomed
  // coordinate system, the available space is viewport_size / zoom_factor.
  // Raw --app-viewport-height is kept unmodified for body/PWA CSS rules that
  // do their own division. Skip on PWA — those modes define --app-shell-height
  // via CSS (percentage or viewport-unit based) and the body rule compensates.
  if (!root.hasAttribute('data-pwa')) {
    const uiScale = parseFloat(root.style.getPropertyValue('--lumiverse-ui-scale')) || 1
    root.style.setProperty('--app-shell-height', `${Math.round(height / uiScale)}px`)
  }
}

let viewportSyncFrame = 0

function scheduleViewportSync() {
  cancelAnimationFrame(viewportSyncFrame)
  viewportSyncFrame = window.requestAnimationFrame(syncViewportVars)
}

scheduleViewportSync()
window.addEventListener('resize', scheduleViewportSync, { passive: true })
window.addEventListener('orientationchange', () => {
  // Orientation change dismisses the keyboard. Recapture base height after
  // the change settles so keyboard detection works in the new orientation.
  setTimeout(() => {
    baseViewportHeight = window.visualViewport?.height ?? window.innerHeight
    scheduleViewportSync()
  }, 300)
}, { passive: true })
window.visualViewport?.addEventListener('resize', scheduleViewportSync)
window.visualViewport?.addEventListener('scroll', scheduleViewportSync)

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

// Utility: find the nearest ancestor with overflow-y: auto or scroll,
// regardless of whether content currently overflows. Used by the focusin
// handler to find containers that can be given scroll room via CSS padding.
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  while (el && el !== document.body && el !== document.documentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === 'auto' || overflowY === 'scroll') return el
    el = el.parentElement
  }
  return null
}

// ── iOS PWA: counteract visual viewport scroll ──
// When the virtual keyboard opens in standalone mode, iOS scrolls the visual
// viewport upward to reveal the focused input. This shifts the entire layout
// (tabs, headers, etc. behind the Dynamic Island). We counteract fully —
// scrollTo(0, 0) keeps the layout stable. Focused inputs in scroll containers
// are revealed via container-level scroll instead (see focusin handler below).
window.visualViewport?.addEventListener('scroll', () => {
  if ((window.navigator as any).standalone && navigator.maxTouchPoints > 0 && window.visualViewport?.offsetTop) {
    window.scrollTo(0, 0)
  }
})

// Flag standalone PWA mode for CSS targeting.
// Check both matchMedia (Chromium/Android) and navigator.standalone (iOS Safari)
// since iOS PWA shells may not advertise display-mode: standalone via CSS.
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as any).standalone === true

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
  const viewport = document.querySelector('meta[name="viewport"]')
  if (viewport) {
    viewport.setAttribute('content', viewport.getAttribute('content') + ', interactive-widget=resizes-content')
  }
}

// ── Viewport lock: prevent pinch-zoom and elastic overscroll ──
// Safari ignores user-scalable=no and maximum-scale in the viewport meta tag
// since iOS 10. These JS handlers catch the gestures that CSS alone cannot.

// Prevent Safari gesturestart/gesturechange (pinch zoom)
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false })
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false })

// Prevent multi-finger zoom on all browsers (2+ touch points = pinch gesture)
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault()
}, { passive: false })

// Prevent desktop trackpad/touchpad pinch-to-zoom. On Windows and macOS,
// Chrome/Edge/Firefox translate trackpad pinch gestures into wheel events
// with ctrlKey=true. Without this, the gesture bypasses all other zoom
// prevention (viewport meta, touch-action, gesture events) and causes
// layout issues — the input area grows disproportionately while the chat
// shrinks, and absolute-positioned elements can drift out of place.
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

  // ── Scroll focused inputs above the keyboard via container scroll ──
  // Since we always counteract iOS's visual viewport scroll (scrollTo 0),
  // the layout never shifts — tabs and headers stay in place. To reveal
  // focused inputs behind the keyboard, we scroll the nearest scroll
  // container (panelContent, modal content). Keyboard-height padding-bottom
  // on these containers (set via CSS) creates scroll room even when the
  // actual content is shorter than the container.
  document.addEventListener('focusin', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable))) return

    const container = findScrollContainer((target as HTMLElement).parentElement)
    if (!container) return

    setTimeout(() => {
      const rect = (target as HTMLElement).getBoundingClientRect()
      const vvBottom = window.visualViewport?.height ?? window.innerHeight
      // If the input's bottom is behind the keyboard, scroll just enough
      if (rect.bottom > vvBottom - 30) {
        container.scrollBy({ top: rect.bottom - vvBottom + 60, behavior: 'smooth' })
      }
    }, 350)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
