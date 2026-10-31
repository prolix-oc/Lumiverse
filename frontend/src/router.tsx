import { lazy, Suspense } from 'react'
import { Spinner } from './components/shared/Spinner'
import { createBrowserRouter, Outlet } from 'react-router'
import App from './App'
import DesktopPwaTitlebar from './components/shared/DesktopPwaTitlebar'
import { isDesktopFloatingWidgetWindow } from './lib/desktop-floating-widget'
import { useStore } from './store'
import { useIOSWidgets } from './hooks/useIOSWidgets'

const LandingPage = lazy(() => import('./components/landing/LandingPage'))
const ChatView = lazy(() => import('./components/chat/ChatView'))
const CharacterBrowser = lazy(() => import('./components/panels/CharacterBrowser'))
const CharacterProfile = lazy(() => import('./components/panels/CharacterProfile'))
const LoginPage = lazy(() => import('./components/auth/LoginPage'))
const SsoCompletePage = lazy(() => import('./components/auth/SsoCompletePage'))
const OAuthConsentPage = lazy(() => import('./components/auth/OAuthConsentPage'))
const StreamDeckHandoffPage = lazy(() => import('./components/StreamDeckHandoffPage'))
const WidgetCharacterPage = lazy(() => import('./components/WidgetCharacterPage'))

function WindowShell() {
  useIOSWidgets(useStore(s => s.isAuthenticated ? s.user?.id ?? null : s.isAuthLoading ? undefined : null))
  return (
    <>
      {!isDesktopFloatingWidgetWindow() && <DesktopPwaTitlebar />}
      <Suspense fallback={<Spinner />}><Outlet /></Suspense>
    </>
  )
}

const routes = [
  {
    element: <WindowShell />,
    children: [
      {
        path: '/login',
        element: <LoginPage />,
      },
      {
        path: '/sso-complete',
        element: <SsoCompletePage />,
      },
      {
        path: '/oauth/consent',
        element: <OAuthConsentPage />,
      },
      {
        path: '/stream-deck/open/chat/:chatId',
        element: <StreamDeckHandoffPage />,
      },
      {
        path: '/',
        element: <App />,
        children: [
          { index: true, element: <LandingPage /> },
          { path: 'chat/:chatId', element: <ChatView /> },
          { path: 'characters', element: <CharacterBrowser /> },
          { path: 'characters/:id', element: <CharacterProfile /> },
          { path: 'widget/character/:id', element: <WidgetCharacterPage /> },
        ],
      },
    ],
  },
]

export const router = createBrowserRouter(routes)
