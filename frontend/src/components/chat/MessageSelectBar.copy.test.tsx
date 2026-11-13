import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
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

const writeText = mock((_text: string): Promise<void> => Promise.resolve())
Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true })

const successToast = mock((_message: string) => '')
const errorToast = mock((_message: string) => '')
mock.module('@/lib/toast', () => ({ toast: { success: successToast, error: errorToast } }))
mock.module('@/api/chats', () => ({ messagesApi: {} }))
mock.module('./MessageSelectBar.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const setMessageSelectMode = mock((enabled: boolean) => {
  state.messageSelectMode = enabled
  state.selectedMessageIds = []
})
const state = {
  messageSelectMode: true,
  selectedMessageIds: [] as string[],
  messages: [] as Message[],
  setMessageSelectMode,
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

function message(id: string, content: string, index: number, hidden = false): Message {
  return {
    id,
    chat_id: 'chat-1',
    index_in_chat: index,
    name: index === 0 ? 'User' : 'Assistant',
    is_user: index === 0,
    content,
    send_date: 1,
    swipe_id: 1,
    swipes: ['Earlier swipe', content],
    swipe_dates: [1, 2],
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
  state.messageSelectMode = true
  state.selectedMessageIds = []
  state.messages = [
    message('first', 'First **message**\nSecond line', 0),
    message('unselected', 'Leave this out', 1),
    message('hidden', 'Selected hidden message', 2, true),
    message('last', 'Latest swipe content', 3),
  ]
  writeText.mockReset()
  writeText.mockImplementation(() => Promise.resolve())
  successToast.mockClear()
  errorToast.mockClear()
  setMessageSelectMode.mockClear()
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

async function renderCopyButton(): Promise<HTMLButtonElement> {
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
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')
  expect(button).not.toBeNull()
  return button!
}

describe('MessageSelectBar bulk copy', () => {
  test('disables Copy when no messages are selected', async () => {
    const button = await renderCopyButton()
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Copy')
    await act(async () => button.click())
    expect(writeText).not.toHaveBeenCalled()
    expect(setMessageSelectMode).not.toHaveBeenCalled()
  })

  test('copies selected messages in chat order with two newlines on each side of every divider', async () => {
    state.selectedMessageIds = ['last', 'hidden', 'first']
    const button = await renderCopyButton()
    expect(button.disabled).toBe(false)
    await act(async () => button.click())

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(
      'First **message**\nSecond line\n\n---\n\nSelected hidden message\n\n---\n\nLatest swipe content',
    )
    expect(successToast).toHaveBeenCalledWith('3 messages copied')
    expect(errorToast).not.toHaveBeenCalled()
    expect(setMessageSelectMode).toHaveBeenCalledWith(false)
  })

  test('copies a single message unchanged without a divider', async () => {
    state.messages = [message('only', '  # Heading\n\nBody  \n', 0)]
    state.selectedMessageIds = ['only']
    const button = await renderCopyButton()
    await act(async () => button.click())

    expect(writeText).toHaveBeenCalledWith('  # Heading\n\nBody  \n')
    expect(successToast).toHaveBeenCalledWith('1 message copied')
  })

  test('keeps the selection available to retry when copying fails', async () => {
    state.selectedMessageIds = ['first', 'last']
    writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'))
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const button = await renderCopyButton()
      await act(async () => button.click())

      expect(errorToast).toHaveBeenCalledWith('Failed to copy messages')
      expect(successToast).not.toHaveBeenCalled()
      expect(setMessageSelectMode).not.toHaveBeenCalled()
      expect(state.messageSelectMode).toBe(true)
      expect(state.selectedMessageIds).toEqual(['first', 'last'])
    } finally {
      consoleError.mockRestore()
    }
  })
})
