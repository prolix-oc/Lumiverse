// Real chat/drawer components with synthetic state; no account or backend required.
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router'
import { LazyMotion, domAnimation } from 'motion/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ChatView from '../src/components/chat/ChatView'
import ViewportDrawer from '../src/components/panels/ViewportDrawer'
import { useStore } from '../src/store'
import { useIOSDuoLayout } from '../src/hooks/useIOSDuoLayout'
import { duoChatStyle, subscribeIOSLayout } from '../src/lib/ios-duo-layout'
import { iosNativeRequest } from '../src/lib/ios-native'
import { charactersApi } from '../src/api/characters'
import { chatsApi, messagesApi } from '../src/api/chats'
import { RouterContextExporter } from '../src/lib/router-bridge'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import enCommon from '../src/i18n/locales/en/common.json'
import enChat from '../src/i18n/locales/en/chat.json'
import enPanels from '../src/i18n/locales/en/panels.json'
import enSettings from '../src/i18n/locales/en/settings.json'
import styles from '../src/App.module.css'
import '../src/theme/reset.css'
import '../src/theme/global.css'

void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { common: enCommon, chat: enChat, panels: enPanels, settings: enSettings } }, initImmediate: false })
for (const [key, value] of Object.entries(generateThemeVariables(DEFAULT_THEME, 'dark'))) document.documentElement.style.setProperty(key, value)
document.documentElement.setAttribute('data-tauri-mobile', 'ios')
const character = { id: 'duo-character', name: 'Duo companion', description: 'A simulator layout fixture.', avatar_path: null, extensions: {}, tags: [], alternate_greetings: [], character_book: null }
charactersApi.get = async () => character as any
chatsApi.get = async () => useStore.getState().chats[0] as any
messagesApi.list = async () => ({ data: useStore.getState().messages, total: 1 }) as any
useStore.setState({
  settingsLoaded: true, isAuthenticated: true, isAuthLoading: false,
  user: { id: 'duo-fixture', name: 'Simulator' }, activeChatId: 'duo-chat', activeCharacterId: character.id,
  characters: [character], activeChatMetadata: {},
  chats: [{ id: 'duo-chat', character_id: character.id, title: 'Duo layout check', metadata: {} }],
  messages: [{ id: 'duo-message', chat_id: 'duo-chat', index_in_chat: 0, name: character.name, is_user: false, content: 'Chat stays on this side while navigation stays open on the other half. Fold, open, or rotate the simulator to check both surfaces.', send_date: Date.now(), swipe_id: 0, swipes: ['Chat stays on this side while navigation stays open on the other half. Fold, open, or rotate the simulator to check both surfaces.'], swipe_dates: [Date.now()], extra: {}, created_at: Date.now() }],
  drawerOpen: false, drawerTab: 'profile',
} as any)

function Fixture() {
  const side = useStore(s => s.drawerSettings.side)
  const duo = useIOSDuoLayout(side)
  const input = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const textarea = document.querySelector('textarea')
      const composer = textarea?.closest('[data-component="InputArea"]')
      const previous = input.current
      if (textarea) input.current = textarea
      void fetch('/layout-snapshots', { method: 'POST', body: JSON.stringify({ rendered: {
        axis: duo?.axis ?? null, chat: document.querySelector('main')?.getBoundingClientRect().toJSON(),
        drawer: document.querySelector('[data-duo-drawer]')?.getBoundingClientRect().toJSON(),
        draft: textarea?.value, sameInput: previous ? previous === textarea : null,
        drawerOpen: useStore.getState().drawerOpen, drawerTab: useStore.getState().drawerTab,
        composer: composer?.getBoundingClientRect().toJSON(), composerRightRadius: composer ? getComputedStyle(composer).borderTopRightRadius : null,
        inputFontSize: textarea ? getComputedStyle(textarea).fontSize : null,
      } }) })
    }, 300)
    return () => clearTimeout(timer)
  }, [duo?.axis, duo?.chat.x, duo?.chat.y, duo?.chat.width, duo?.chat.height])
  useEffect(() => subscribeIOSLayout(layout => {
    void fetch('/layout-snapshots', { method: 'POST', body: JSON.stringify(layout) })
  }), [])
  useEffect(() => {
    void iosNativeRequest('layout.status').then(layout => fetch('/layout-snapshots', { method: 'POST', body: JSON.stringify({ raw: layout }) }))
      .catch(error => fetch('/fixture-errors', { method: 'POST', body: JSON.stringify({ native: String(error) }) }))
  }, [])
  return <LazyMotion features={domAnimation}>
    <div className={duo ? `${styles.app} ${styles.duoApp}` : styles.app} data-app-root="" data-duo-layout={duo?.axis}
      data-duo-drawer-side={duo?.axis === 'horizontal' ? side : undefined}
      style={{ '--duo-window-keyboard-inset-bottom': 'var(--app-keyboard-inset-bottom, 0px)' } as React.CSSProperties}>
      <RouterContextExporter />
      <main className={duo ? `${styles.main} ${styles.duoMain}` : styles.main} data-duo-chat={duo ? '' : undefined}
        style={duo ? duoChatStyle(duo) : undefined}>
        <ChatView />
      </main>
      <ViewportDrawer duoLayout={duo} />
    </div>
  </LazyMotion>
}

createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/chat/duo-chat']}><Routes><Route path="/chat/:chatId" element={<Fixture />} /></Routes></MemoryRouter>)
