import { createRoot } from 'react-dom/client'
import { useStore } from '@/store'
import { registerDisplayResolver } from '@/lib/spindle/display-resolver-registry'
import { getHostSurfaceRenderer, validateHostSurfaceProps } from '@/lib/spindle/host-surface-registry'
import '@/lib/spindle/message-preview-host-surface'
import { REGEX_ACTION_EVENT } from '@/lib/regex/actionBus'

const source = 'Before\n\n<!-- CARD_START -->{"title":"Resolved island"}<!-- CARD_END -->\n\nAfter'
const start = source.indexOf('<!-- CARD_START -->')
const end = source.indexOf('\n\nAfter')
const payload = { id: 'continue', scriptId: 'rule', instanceId: 'fixture-action', type: 'send', multi_select: false, cost: 1, limit: 0, content: 'Continue', title: '', subtitle: '' }
export const rendered = `<div><style>h2{color:var(--lumiverse-text)}button{padding:8px}</style><h2>Resolved island</h2><button data-lumiverse-regex-action="${encodeURIComponent(JSON.stringify(payload))}">Continue</button><details><summary>Details</summary>Preview details</details></div>`
const message = { id: 'message', chat_id: 'chat', content: source, is_user: false, swipe_id: 0, swipes: [source, 'Second swipe'], extra: {} }
useStore.setState({
  activeChatId: 'chat', activeChatDisplayOwner: 'fixture-owner', activeCharacterId: null,
  activeGroupCharacterId: null, activePersonaId: null, personas: [], user: { name: 'Reader' },
  messages: [message], characters: [], groupCharacterIds: [], isGroupChat: false,
  oocEnabled: false, lumiaOOCStyle: 'card', longMessageCollapseEnabled: true, longMessageCollapsePreset: 'comfortable',
  longMessageCollapseCustomHeight: 500, longMessageCollapseDepth: 3, expandedLongMessageKeys: [], setLongMessageExpanded() { throw new Error('Preview changed source collapse state') },
  regexScripts: [{ id: 'rule', name: 'Fixture rule', scope: 'global', disabled: false, target: ['display'], placement: ['ai_output'], find_regex: 'CARD_START', replace_string: '', flags: 'g', substitute_macros: 'none', trim_strings: [], min_depth: null, max_depth: null, actions: [payload] }],
} as any)
registerDisplayResolver('fixture-owner', {
  ready: () => true,
  resolveBody: async ({ content }) => ({ content, processingState: 'owned-preview' }),
  resolveTemplates: async () => ({ resolved: {} }),
  applyScripts: async ({ content }) => ({ content: content.includes('CARD_START') ? rendered : content }),
})
let actionCount = 0
window.addEventListener(REGEX_ACTION_EVENT, () => { actionCount += 1 })
const host = document.getElementById('preview')!
let root = createRoot(host)
let props = { chatId: 'chat', messageId: 'message', swipeIndex: 0, start, end }
const render = () => root.render(getHostSurfaceRenderer('message_preview')!(validateHostSurfaceProps('message_preview', props), { extensionId: 'preview-fixture', emit() {} }))
render()
Object.assign(window, { messagePreviewFixture: {
  rendered, actionCount: () => actionCount,
  swipe(index: number) { props = { ...props, swipeIndex: index, start: 0, end: index === 0 ? source.length : 'Second swipe'.length }; render() },
  range() { props = { ...props, swipeIndex: 0, start, end }; render() },
  backend() { useStore.setState({ activeChatDisplayOwner: null }); props = { ...props, start: 0, end: source.length }; render() },
  navigate() { useStore.setState({ activeChatId: 'other' }) },
  restore() { useStore.setState({ activeChatId: 'chat', activeChatDisplayOwner: 'fixture-owner', messages: [message] as any }); render() },
  remove() { useStore.setState({ messages: [] }) },
  unmount() { root.unmount() },
  remount() { root = createRoot(host); render() },
} })
