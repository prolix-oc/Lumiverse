import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import { router } from './router'
import './theme/variables.css'
import './theme/reset.css'
import './theme/global.css'

// Register service worker for PWA support — autoUpdate reloads on new versions
registerSW({ immediate: true })

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

// ── iOS PWA: counteract visual viewport scroll ──
// When the virtual keyboard opens in standalone mode, iOS scrolls the visual
// viewport upward to reveal the focused input. This shifts the entire layout.
// We counteract by scrolling back to 0 — the input bar repositions itself
// above the keyboard via --app-keyboard-inset-bottom instead.
// Guard with maxTouchPoints > 0 to skip macOS Safari "Add to Dock" apps,
// which also set navigator.standalone but don't have this keyboard behavior.
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
