import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import panels from '../src/i18n/locales/en/panels.json'
import ThemePanel from '../src/components/panels/ThemePanel'
import { useThemeApplicator } from '../src/hooks/useThemeApplicator'
import { setDeviceThemeControlsScope, useDeviceThemeControls } from '../src/lib/deviceThemeControls'
import { useStore } from './device-theme-controls.store'
import '../src/theme/reset.css'
import '../src/theme/global.css'

await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { panels } } })
setDeviceThemeControlsScope('fixture-user')
Object.assign(window, { deviceFixture: { store: useStore, device: useDeviceThemeControls, scope: setDeviceThemeControlsScope } })

function Fixture() {
  useThemeApplicator()
  const [open, setOpen] = useState(true)
  return <main style={{ maxWidth: 420, margin: 'auto', height: 'var(--app-scaled-viewport-height)', overflow: 'auto', padding: 'calc(var(--app-interactive-safe-top) + 12px) 12px 24px' }}>
    <button onClick={() => setOpen(!open)}>{open ? 'Close theme panel' : 'Open theme panel'}</button>
    {open && <ThemePanel />}
  </main>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
