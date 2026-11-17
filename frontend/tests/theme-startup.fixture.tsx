import { StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { useAppInit } from '../src/hooks/useAppInit'
import { useThemeApplicator } from '../src/hooks/useThemeApplicator'
import { useCustomCSSApplicator } from '../src/hooks/useCustomCSSApplicator'
import { initializeSafeThemeMode } from '../src/lib/safeThemeMode'
import '../src/theme/variables.css'

await initializeSafeThemeMode()
useStore.setState({ user: { id: 'theme-fixture-user' } as never, isAuthenticated: true, isAuthLoading: false })
const observations: { color: string; padding: string; css: string }[] = []
function Fixture() {
  const ready = useStore(s => s.settingsLoaded)
  useThemeApplicator(ready)
  useCustomCSSApplicator()
  useAppInit()
  // Runs after the applicators, before the first opportunity to paint.
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-shell]')
    if (!shell) return
    const style = getComputedStyle(shell)
    observations.push({ color: style.color, padding: style.padding, css: document.getElementById('lumiverse-user-css')?.textContent ?? '' })
  })
  return ready ? <main data-shell>Saved theme</main> : <span data-startup>Loading</span>
}
Object.assign(window, { themeStartupFixture: { store: useStore, observations } })
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
