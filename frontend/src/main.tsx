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

// Flag standalone PWA mode for CSS targeting.
// Check both matchMedia (Chromium/Android) and navigator.standalone (iOS Safari)
// since iOS PWA shells may not advertise display-mode: standalone via CSS.
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as any).standalone === true

if (isStandalone) {
  document.documentElement.setAttribute('data-pwa', '')
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
