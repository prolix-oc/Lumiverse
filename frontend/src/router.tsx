import { createBrowserRouter } from 'react-router'
import App from './App'
import LandingPage from './components/landing/LandingPage'
import ChatView from './components/chat/ChatView'
import CharacterBrowser from './components/panels/CharacterBrowser'
import CharacterProfile from './components/panels/CharacterProfile'
import LoginPage from './components/auth/LoginPage'

export const router = createBrowserRouter([
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
])
