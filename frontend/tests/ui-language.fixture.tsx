// Real auth/settings stores, locale chunks and controls; HTTP is controlled by Playwright.
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { initI18n } from '@/i18n'
import { useUiLanguage } from '@/hooks/useUiLanguage'
import LoginPage from '@/components/auth/LoginPage'
import LanguageSwitcher from '@/components/shared/LanguageSwitcher'
import '@/theme/reset.css'

function Account() {
  useUiLanguage()
  const user = useStore(s => s.user)
  const authenticated = useStore(s => s.isAuthenticated)
  const language = useStore(s => s.uiLanguage)
  const loaded = useStore(s => s.fullSettingsLoaded)
  const { i18n } = useTranslation()
  useEffect(() => {
    if (authenticated) void useStore.getState().loadSettings()
  }, [authenticated, user?.id])
  if (!authenticated) return <Navigate to="/login" replace />
  return <main>
    <h1>Account {user?.id}</h1>
    <LanguageSwitcher />
    <output id="account-language">{language}</output>
    <output id="display-language">{i18n.language}</output>
    <output id="settings-loaded">{String(loaded)}</output>
    <button onClick={() => { void useStore.getState().loadSettings() }}>Refresh settings</button>
    <button onClick={() => { void useStore.getState().logout() }}>Sign out</button>
  </main>
}

await initI18n()
createRoot(document.getElementById('root')!).render(<BrowserRouter><Routes>
  <Route path="/login" element={<LoginPage />} />
  <Route path="*" element={<Account />} />
</Routes></BrowserRouter>)
