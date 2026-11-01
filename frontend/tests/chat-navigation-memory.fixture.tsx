import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { BrowserRouter } from 'react-router'
import MessageList from '@/components/chat/MessageList'
import { useStore } from '@/store'
import { messagesApi } from '@/api/chats'
import { registerDisplayResolver } from '@/lib/spindle/display-resolver-registry'
import { registerTagInterceptor } from '@/lib/spindle/message-interceptors'
import { createDOMHelper } from '@/lib/spindle/dom-helper'
import { getLiveRootRecords } from '@/lib/spindle/live-root-registry'
import { getDisplayContentCacheStatsForTests } from '@/hooks/useDisplayRegex'
import chatStyles from '@/components/chat/ChatView.module.css'
import '@/theme/variables.css'
import '@/theme/reset.css'
import '@/theme/global.css'
import type { Message } from '@/types/api'

const chatId = 'navigation-memory-fixture'
const params = new URLSearchParams(location.search)
const rich = params.get('rich') !== '0'
const animation = params.get('animation') !== '0'
const retainWrapper = params.get('retain') !== '0'
const extensionId = '00000000-0000-0000-0000-000000000081'
const dom = createDOMHelper(extensionId, 'memory_fixture')
const mounts = new Map<string, Element>()
const rendered = new Set<string>()
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const scene = (window as Window & { memorySceneHtml?: string }).memorySceneHtml || `<div><style>.memory-scene{padding:24px;border-radius:18px;background:linear-gradient(130deg,#272234,#493652);box-shadow:0 8px 32px #0006}.memory-scene h3{margin:0 0 12px}.memory-scene p{line-height:1.6}</style><article class="memory-scene"><h3>Scene card</h3><p>${'A synthetic scene with several characters and a changing narrative. '.repeat(12)}</p></article></div>`
const baseMessages = Array.from({ length: 50 }, (_, index) => ({
  id: `message-${index}`, chat_id: chatId, index_in_chat: index, is_user: index % 2 === 0,
  name: index % 2 === 0 ? 'User' : 'Character', content: `Message ${index}. ${'Ordinary narrative text. '.repeat(20)}`,
  send_date: 1700000000, swipe_id: 0, swipes: [], extra: {},
} as unknown as Message)).map(message => ({ ...message, swipes: [message.content] }))

useStore.setState({
  characters: [], personas: [], groupCharacterIds: [], regexScripts: [], expandedLongMessageKeys: [], chatStyleModes: {},
  chatDisplayMode: 'bubble', oocEnabled: false, lumiaOOCStyle: 'raw',
  longMessageCollapseEnabled: false, isGroupChat: false, messagesPerPage: 50,
} as never)
messagesApi.before = async () => ({ data: [], has_more: false, limit: 50 })
registerDisplayResolver('memory-fixture', {
  ready: () => true, finalizeWithoutScripts: true,
  resolveBody: async ({ content }) => { await pause(12); return { content, cacheable: true } },
  resolveTemplates: async ({ templates }) => ({ resolved: templates }),
  applyScripts: async ({ content }) => {
    await pause(30)
    return { content: rich ? content.replace('[scene]', scene) : content }
  },
} as Parameters<typeof registerDisplayResolver>[1])
registerTagInterceptor(extensionId, 'Memory fixture', {
  tagName: 'tracker', removeFromMessage: true,
}, payload => {
  if (!payload.messageId || rendered.has(payload.messageId)) return
  const target = dom.findMessageElement(payload.messageId)
  if (!target) return
  const wrapper = dom.inject(target, `<section style="padding:24px;border:1px solid #76678e;border-radius:16px;background:#282331"><h3>Extension tracker</h3>${Array.from({ length: 12 }, (_, i) => `<p>Character ${i}: synthetic tracker value</p>`).join('')}</section>`)
  rendered.add(payload.messageId)
  if (retainWrapper) mounts.set(payload.messageId, wrapper)
})
document.documentElement.setAttribute('data-glass', '')
document.documentElement.setAttribute('data-chat-bg', '')

let changeRoute: (route: 'home' | 'chat') => void
let changeLeaving: (leaving: boolean) => void
let cycle = 0
let prefix = ''
let chunks = 0
const api = {
  async open() {
    for (const mount of mounts.values()) dom.uninject(mount)
    mounts.clear()
    rendered.clear()
    const state = useStore.getState()
    state.setActiveChat(chatId)
    useStore.setState({ activeChatDisplayOwner: 'memory-fixture', messages: baseMessages, totalChatLength: 50 })
    changeLeaving(false)
    changeRoute('chat')
    await pause(600)
    state.startStreaming(`generation-${++cycle}`)
    prefix = rich ? '[scene]\n<tracker type="sim">{"value":1}</tracker>\n' : ''
    chunks = 0
    state.appendStreamToken(prefix)
  },
  tick(count = 1) {
    for (let i = 0; i < count; i++) {
      useStore.getState().appendStreamToken(`Streaming sentence ${++chunks}. `)
    }
  },
  async home() {
    const state = useStore.getState()
    state.pauseStreamingForNavigation()
    changeLeaving(animation)
    if (animation) await pause(220)
    state.setActiveChat(null)
    changeRoute('home')
    await pause(300)
  },
  snapshot() {
    let nodes = 0
    let islands = 0
    let runningAnimations = 0
    const sceneCards: Array<{ width: number; height: number; background: string; beforeAnimation: string }> = []
    const visit = (root: Document | ShadowRoot) => {
      const elements = root.querySelectorAll('*')
      nodes += elements.length
      for (const element of elements) {
        runningAnimations += element.getAnimations().filter(animation => animation.playState === 'running').length
        if (element.matches('.sc-card')) {
          const bounds = element.getBoundingClientRect()
          sceneCards.push({ width: bounds.width, height: bounds.height,
            background: getComputedStyle(element).backgroundImage,
            beforeAnimation: getComputedStyle(element, '::before').animationName })
        }
        if (element.shadowRoot) { islands++; visit(element.shadowRoot) }
      }
    }
    visit(document)
    const { hasKey: _hasKey, ...cache } = getDisplayContentCacheStatsForTests()
    return { cycle, nodes, islands, runningAnimations, sceneCards, retainedTrackerMounts: mounts.size,
      liveInjectionRoots: getLiveRootRecords(extensionId).length,
      detachedTrackerParents: [...mounts.values()].filter(mount => !mount.isConnected && mount.parentNode).length,
      mountedRows: document.querySelectorAll('[data-virtual-index]').length, cache }
  },
}
Object.assign(window, { memoryFixture: api })
function Fixture() {
  const [route, setRoute] = useState<'home' | 'chat'>('home')
  const [leaving, setLeaving] = useState(false)
  changeRoute = setRoute
  changeLeaving = setLeaving
  const messages = useStore(state => state.messages)
  const streaming = useStore(state => state.isStreaming)
  return <BrowserRouter>{route === 'chat'
    ? <div className={chatStyles.chatColumnInner} data-chat-chrome-leaving={leaving || undefined}>
      <MessageList messages={messages} chatId={chatId} isStreaming={streaming} />
    </div>
    : <div>Home</div>}</BrowserRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
