import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import MinimalMessage from '@/components/chat/MinimalMessage'
import BubbleMessage from '@/components/chat/BubbleMessage'
import MessageContent from '@/components/chat/MessageContent'
import { useStore } from '@/store'
import { initI18n } from '@/i18n'
import { registerTagInterceptor } from '@/lib/spindle/message-interceptors'
import { reconcileMessageTagRuntimeCapabilities } from '@/lib/spindle/message-tag-runtime-readiness'
import type { SpindleMessageTagIntercept } from 'lumiverse-spindle-types'
import type { Message } from '@/types/api'
import '@/theme/variables.css'
import '@/theme/reset.css'
import '@/theme/global.css'

const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="purple"/></svg>'
const source = `<illustration id="first">private first packet</illustration>\n**After first**\n\n![ordinary](${encodeURI(image)})\n\n<illustration id="second">private second packet</illustration>\n*After second*`
const message = {
  id: 'slot-message', chat_id: 'slot-chat', index_in_chat: 0, is_user: false,
  swipe_id: 0, swipes: [source, source], content: source, send_date: 1700000000, extra: {},
} as Message
useStore.setState({
  activeChatId: message.chat_id, activeChatDisplayOwner: null, messages: [message],
  activeCharacterId: null, activeGroupCharacterId: null, activePersonaId: null,
  characters: [], groupCharacterIds: [], regexScripts: [], expandedLongMessageKeys: [],
  chatStyleModes: {}, oocEnabled: false, lumiaOOCStyle: 'raw', isGroupChat: false,
  longMessageCollapseEnabled: false, isStreaming: true, streamingContent: source,
  streamingGenerationType: 'regenerate', regeneratingMessageId: message.id, streamingSwipeId: 0,
})
reconcileMessageTagRuntimeCapabilities([])
const deliveries: SpindleMessageTagIntercept[] = []
let dispose = registerTagInterceptor('slot-fixture', 'Slot fixture', {
  tagName: 'illustration', displaySlot: payload => ({ key: payload.attrs.id, aspectRatio: 4 / 3 }),
}, payload => deliveries.push(payload))

// Simulate an extension that restores its UI when a virtualized anchor mounts.
// Handler delivery may precede DOM insertion and is intentionally independent.
const observer = new MutationObserver(() => {
  for (const anchor of document.querySelectorAll<HTMLElement>('[data-spindle-tag-display="slot-fixture"]')) {
    if (anchor.shadowRoot) continue
    const shadow = anchor.attachShadow({ mode: 'open' })
    const img = document.createElement('img')
    img.src = image
    img.alt = `Preview ${anchor.dataset.spindleTagDisplayKey}`
    const button = document.createElement('button')
    button.textContent = 'Interact'
    button.onclick = () => { button.textContent = 'Clicked' }
    shadow.append(img, button)
  }
})
observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
const root = createRoot(document.getElementById('root')!)
const bubble = new URLSearchParams(location.search).get('cards') === 'bubble'
function Fixture() {
  const displayed = useStore(s => s.messages[0])
  const chatId = useStore(s => s.activeChatId)!
  const Card = bubble ? BubbleMessage : MinimalMessage
  return <BrowserRouter><main style={{ maxWidth: 800, margin: 'auto', width: '100%', minWidth: 0 }}>
    <Card message={displayed} chatId={chatId} />
    <aside aria-label="Read-only preview"><MessageContent content={source} chatId={chatId} messageId="preview"
      isUser={false} userName="Reader" tagDisplaySwipeIndex={0} readOnly /></aside>
  </main></BrowserRouter>
}
const fixture = {
  store: useStore, source, deliveries,
  update(tail: string) {
    const current = useStore.getState().messages[0]
    const content = source + tail
    useStore.setState({ streamingContent: content, messages: [{ ...current, content, swipes: [content, content] }] })
  },
  swipe(swipe: number) {
    useStore.setState(s => ({ streamingSwipeId: swipe, messages: [{ ...s.messages[0], swipe_id: swipe }] }))
  },
  finish() { useStore.setState({ isStreaming: false, streamingContent: '', regeneratingMessageId: null }) },
  remount() { root.render(null); requestAnimationFrame(() => root.render(<Fixture />)) },
  dispose() { dispose(); dispose = () => {}; observer.disconnect() },
}
declare global { interface Window { tagDisplayFixture: typeof fixture } }
window.tagDisplayFixture = fixture
await initI18n()
root.render(<Fixture />)
