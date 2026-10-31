import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import MessageList from '@/components/chat/MessageList'
import { useStore } from '@/store'
import { messagesApi } from '@/api/chats'
import { registerDisplayResolver } from '@/lib/spindle/display-resolver-registry'
import { resetDisplayRegexCachesForTests } from '@/hooks/useDisplayRegex'
import type { Message } from '@/types/api'
import '@/theme/variables.css'
import '@/theme/reset.css'
import '@/theme/global.css'

const chatId = 'scroll-fixture'
const mode = new URLSearchParams(location.search).get('mode') ?? 'mixed'
const displayMode = new URLSearchParams(location.search).get('cards') ?? 'minimal'
const displayDelay = Number(new URLSearchParams(location.search).get('delay') ?? 120)
const paginated = new URLSearchParams(location.search).get('pages') === '1'
if (new URLSearchParams(location.search).get('glass') === '1') {
  document.documentElement.setAttribute('data-glass', '')
  document.documentElement.setAttribute('data-chat-bg', '')
  document.body.style.background = 'repeating-linear-gradient(45deg,#19181f,#19181f 40px,#383049 40px,#383049 80px)'
}
const isHtml = (index: number) => mode === 'html' || (mode === 'mixed' && index % 2 === 1)
const messages = Array.from({ length: 120 }, (_, index) => ({
  id: `message-${index}`, chat_id: chatId, index_in_chat: index,
  is_user: false, swipe_id: 0, extra: {},
  content: isHtml(index) ? `Source ${index}: <span style="visibility:visible">${'provisional text '.repeat(12)}</span>`
    : `Message ${index}. ${'Ordinary chat text with no HTML. '.repeat(2 + index % 9)}`,
} as Message)).map(message => ({ ...message, swipes: [message.content], send_date: 1700000000 }))

useStore.setState({
  activeChatId: chatId, activeChatDisplayOwner: 'scroll-fixture',
  activeCharacterId: null, activeGroupCharacterId: null, activePersonaId: null,
  messages: paginated ? messages.slice(-20) : messages, totalChatLength: messages.length, messagesPerPage: 20,
  characters: [], groupCharacterIds: [],
  regexScripts: [], expandedLongMessageKeys: [], chatStyleModes: {},
  chatDisplayMode: displayMode, oocEnabled: false, lumiaOOCStyle: 'raw',
  longMessageCollapseEnabled: false, isGroupChat: false,
} as never)

registerDisplayResolver('scroll-fixture', {
  ready: () => true,
  finalizeWithoutScripts: true,
  resolveBody: async ({ content }) => {
    await new Promise(resolve => setTimeout(resolve, 12))
    return { content, cacheable: true }
  },
  resolveTemplates: async ({ templates }) => ({ resolved: templates }),
  applyScripts: async ({ content }) => {
    await new Promise(resolve => setTimeout(resolve, displayDelay))
    const index = Number(content.match(/^(?:Source|Message) (\d+)/)?.[1])
    return { content: isHtml(index)
      ? `<div><style>.fixture-html{padding:18px;background:#323044;border:1px solid #a99cdb}.fixture-html p{margin:0 0 12px}</style><article class="fixture-html" style="min-height:${120 + index % 9 * 180}px"><p>Rendered card ${index}</p><p>${'Resolved HTML content. '.repeat(1 + index % 6)}</p></article></div>`
      : content }
  },
} as Parameters<typeof registerDisplayResolver>[1])

messagesApi.before = async (_chatId, boundary, limit) => {
  await new Promise(resolve => setTimeout(resolve, 250))
  const older = messages.filter(message => message.index_in_chat < boundary.index)
  return { data: older.slice(-limit), has_more: older.length > limit, limit }
}
Object.assign(window, {
  clearScrollFixtureCaches: resetDisplayRegexCachesForTests,
  scrollFixtureLoadedCount: () => useStore.getState().messages.length,
})
function Fixture() {
  const loaded = useStore(s => s.messages)
  return <BrowserRouter><MessageList messages={loaded} chatId={chatId} isStreaming={false} /></BrowserRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
