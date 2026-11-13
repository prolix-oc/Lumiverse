import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { JSDOM } from 'jsdom'
import chatTranslations from '@/i18n/locales/en/chat.json'
import commonTranslations from '@/i18n/locales/en/common.json'
import type { Message } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, globalObject[key]]),
)
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})

mock.module('@/lib/toast', () => ({ toast: { success: mock(), error: mock() } }))
mock.module('@/api/chats', () => ({ messagesApi: {} }))
mock.module('./MessageSelectBar.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const state = {
  messageSelectMode: true,
  selectedMessageIds: [] as string[],
  messages: [] as Message[],
  setMessageSelectMode: mock(),
  toggleMessageSelect: mock(),
  selectAllMessages: mock(),
  clearMessageSelection: mock(),
  selectMessageRange: mock(),
  removeMessage: mock(),
  openModal: mock(),
}
mock.module('@/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}))

function message(id: string, index: number, hidden = false): Message {
  return {
    id,
    chat_id: 'chat-1',
    index_in_chat: index,
    name: index === 0 ? 'User' : 'Assistant',
    is_user: index === 0,
    content: `Message ${index}`,
    send_date: 1,
    swipe_id: 0,
    swipes: [`Message ${index}`],
    swipe_dates: [1],
    extra: { hidden },
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
  }
}

const i18n = createInstance()
let createRoot: typeof CreateRoot
let MessageSelectBar: typeof import('./MessageSelectBar').default
let root: Root | null = null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { chat: chatTranslations, common: commonTranslations } },
    interpolation: { escapeValue: false },
  })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: MessageSelectBar } = await import('./MessageSelectBar'))
})

beforeEach(() => {
  state.messages = [message('visible', 0), message('hidden', 1, true), message('spare', 2)]
  state.selectedMessageIds = []
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <MessageSelectBar chatId="chat-1" />
      </I18nextProvider>,
    )
  })
  return host
}

describe('MessageSelectBar accessibility', () => {
  test('the bar is a named region', async () => {
    const host = await render()
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Message selection')
  })

  test('every control has an accessible name', async () => {
    state.selectedMessageIds = ['visible', 'hidden']
    const host = await render()
    const buttons = Array.from(host.querySelectorAll('button'))
    // .actionLabel is display:none under 480px, so the visible text these
    // buttons rely on disappears on a phone and only the label is left.
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
    }
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Select all', 'Copy', 'Hide', 'Unhide', 'Delete', 'Cancel',
    ])
  })

  test('the select-all control reports whether it is on', async () => {
    let host = await render()
    let toggle = host.querySelector('button[aria-pressed]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Select all')

    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()

    state.selectedMessageIds = ['visible', 'hidden', 'spare']
    host = await render()
    toggle = host.querySelector('button[aria-pressed]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Deselect all')
  })

  test('the count is announced when it changes', async () => {
    state.selectedMessageIds = ['visible']
    const host = await render()
    const status = host.querySelector('[role="status"]')
    // Toggling a checkbox gives no other feedback, so this is the only way a
    // screen reader learns the selection grew.
    expect(status?.textContent).toBe('1 of 3 selected')
  })
})
