import { createBrowserRouter, createMemoryRouter } from 'react-router'
import App from './App'
import LandingPage from './components/landing/LandingPage'
import ChatView from './components/chat/ChatView'
import CharacterBrowser from './components/panels/CharacterBrowser'
import CharacterProfile from './components/panels/CharacterProfile'
import LoginPage from './components/auth/LoginPage'

const routes = [
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <LandingPage /> },
      { path: 'chat/:chatId', element: <ChatView /> },
      { path: 'characters', element: <CharacterBrowser /> },
      { path: 'characters/:id', element: <CharacterProfile /> },
    ],
  },
]

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as any).standalone === true

const initialEntry = `${window.location.pathname}${window.location.search}${window.location.hash}`

export const router = isStandalone
  ? createMemoryRouter(routes, { initialEntries: [initialEntry] })
  : createBrowserRouter(routes)
