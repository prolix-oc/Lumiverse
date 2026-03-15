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

  // Measure actual viewport height — works around WebKit bug #237961 where
  // CSS viewport units (dvh/vh/%) miscalculate in standalone + viewport-fit=cover.
  const setAppHeight = () => {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`)
  }
  setAppHeight()
  window.addEventListener('resize', setAppHeight)
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
