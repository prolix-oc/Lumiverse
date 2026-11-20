import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
const seen: Array<Record<string, unknown>> = []
let fetchMessage: () => Promise<any> = async () => null
mock.module('@/api/chats', () => ({ messagesApi: { get: () => fetchMessage() } }))
const state = {
  activeChatId: 'chat-1', activePersonaId: 'persona-1', personas: [{ id: 'persona-1', name: 'Reader' }], user: null,
  messages: [{ id: 'message-1', chat_id: 'chat-1', is_user: false, swipe_id: 0, content: 'First', swipes: ['First', 'Before\n\n<!-- CARD_START -->{"count":2}<!-- CARD_END -->\n\nAfter'] }],
}
mock.module('@/store', () => ({ useStore: (select: (value: typeof state) => unknown) => select(state) }))
mock.module('@/components/chat/MessageContent', () => ({ default: (props: Record<string, unknown>) => {
  seen.push(props)
  return <div data-native-preview>{String(props.content)}</div>
} }))
const { getHostSurfaceRenderer, validateHostSurfaceProps } = await import('./host-surface-registry')
await import('./message-preview-host-surface')
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  seen.length = 0
  state.activeChatId = 'chat-1'
  state.messages[0]!.swipes[1] = 'Before\n\n<!-- CARD_START -->{"count":2}<!-- CARD_END -->\n\nAfter'
})
async function render(props: Record<string, unknown>) {
  if (!host) { host = document.createElement('div'); document.body.append(host) }
  if (!root) root = createRoot(host)
  await act(async () => root!.render(getHostSurfaceRenderer('message_preview')!(props, { extensionId: 'test-preview', emit() {} })))
}

describe('message_preview host surface', () => {
  test('validates the anchored source identity and rejects unsafe ranges and extra data', () => {
    const identity = { chatId: 'chat-1', messageId: 'message-1' }
    expect(validateHostSurfaceProps('message_preview', identity)).toEqual(identity)
    for (const extra of [{ start: -1 }, { start: 2, end: 1 }, { swipeIndex: 0.5 }, { content: '<script>x</script>' }, { chatId: '' }]) {
      expect(() => validateHostSurfaceProps('message_preview', { ...identity, ...extra })).toThrow('HOST_SURFACE_PROPS_INVALID')
    }
  })
  test('uses the selected canonical swipe and exact source offsets with the native renderer', async () => {
    const source = state.messages[0]!.swipes[1]!
    const start = source.indexOf('<!-- CARD_START -->')
    const end = source.indexOf('\n\nAfter')
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 1, start, end })
    expect(seen.at(-1)).toMatchObject({ content: source.slice(start, end), chatId: 'chat-1', messageId: 'message-1', isUser: false, userName: 'Reader', depth: 0, readOnly: true })
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 0 })
    expect(seen.at(-1)?.content).toBe('First')
    state.activeChatId = 'other-chat'
    seen.length = 0
    await render({ chatId: 'chat-1', messageId: 'message-1' })
    expect(seen).toHaveLength(0)
    expect(host?.textContent).toContain('unavailable')
    state.activeChatId = 'chat-1'
    await render({ chatId: 'chat-1', messageId: 'missing' })
    expect(seen).toHaveLength(0)
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 9 })
    expect(seen).toHaveLength(0)
    await render({ chatId: 'chat-1', messageId: 'message-1', start: 999 })
    expect(seen).toHaveLength(0)
  })
  test('hydrates light swipe projections without mutating the store or accepting stale completions', async () => {
    const source = state.messages[0]!.swipes[1]
    state.messages[0]!.swipes[1] = null as any
    let resolve: (value: any) => void = () => {}
    fetchMessage = () => new Promise(done => { resolve = done })
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 1 })
    expect(host?.textContent).toContain('Loading')
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 0 })
    await act(async () => { resolve({ ...state.messages[0], chat_id: 'chat-1', swipes: ['First', source] }) })
    expect(seen.at(-1)?.content).toBe('First')
    fetchMessage = async () => ({ ...state.messages[0], chat_id: 'chat-1', swipes: ['First', source] })
    await render({ chatId: 'chat-1', messageId: 'message-1', swipeIndex: 1 })
    expect(seen.at(-1)?.content).toBe(source)
    expect(state.messages[0]!.swipes[1]).toBeNull()
  })
})
