/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { act as Act } from 'react'
import type { useStore as UseStore } from '@/store'
import type { default as MessageContentType } from './MessageContent'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
const domWindow = dom.window

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Node: domWindow.Node,
  NodeFilter: domWindow.NodeFilter,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
})

Object.assign(domWindow, {
  matchMedia: () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
  requestAnimationFrame: (callback: FrameRequestCallback) => domWindow.setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: number) => domWindow.clearTimeout(id),
})
Object.assign(globalThis, {
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

const resizeObservers: TestResizeObserver[] = []
class TestResizeObserver {
  private readonly callback: ResizeObserverCallback
  private readonly targets = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  trigger() {
    const entries = [...this.targets].map((target) => ({ target })) as ResizeObserverEntry[]
    this.callback(entries, this as unknown as ResizeObserver)
  }
}
Object.assign(domWindow, { ResizeObserver: TestResizeObserver })
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })

const translations: Record<string, string> = {
  'messageContent.readMore': 'Read more',
  'messageContent.showLess': 'Show less',
  assistantFallback: 'Assistant',
}
const translate = (key: string) => translations[key] ?? key
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
  I18nextProvider: ({ children }: { children?: unknown }) => children ?? null,
  initReactI18next: { type: '3rdParty', init() {} },
}))
mock.module('@/i18n', () => ({
  default: { t: translate },
  changeUiLanguage: async () => {},
  ensureLanguageLoaded: async () => {},
  initI18n: async () => ({ t: translate }),
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
}))

let createRoot: typeof CreateRoot
let MessageContent: typeof MessageContentType
let useStore: typeof UseStore
let act: typeof Act
let root: Root | null = null
let host: HTMLDivElement

function setRenderedBodyHeight(height: number): HTMLElement {
  const body = host.querySelector<HTMLElement>('[data-component="MessageContent"] > div > div')
  if (!body) throw new Error('MessageContent body did not render')
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, get: () => height },
    offsetHeight: { configurable: true, get: () => height },
  })
  return body
}

async function flushLayout() {
  await act(async () => {
    for (const observer of resizeObservers) observer.trigger()
    await new Promise((resolve) => domWindow.setTimeout(resolve, 20))
  })
}

// These imports must happen after Bun installs the dependency mocks; static imports evaluate first.
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: MessageContent } = await import('./MessageContent'))
  ;({ useStore } = await import('@/store'))
  ;({ act } = await import('react'))
  mock.restore()
})

beforeEach(() => {
  resizeObservers.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({
    longMessageCollapseEnabled: true,
    longMessageCollapsePreset: 'comfortable',
    expandedLongMessageKeys: [],
  })
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host.remove()
})

afterAll(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host?.remove()
  resizeObservers.length = 0
  domWindow.localStorage.clear()
  domWindow.close()
  mock.restore()
})

describe('MessageContent long-message collapsing', () => {
  test('clips an overflowing streaming assistant message and toggles it open', async () => {
    await act(async () => {
      root?.render(
        <MessageContent
          content={'Long assistant content '.repeat(80)}
          isUser={false}
          userName="User"
          isStreaming
          chatId="chat-1"
          messageId="message-1"
        />,
      )
    })
    setRenderedBodyHeight(700)
    await flushLayout()

    const viewport = host.querySelector<HTMLElement>('[data-component="MessageContent"] > div')
    const toggle = host.querySelector<HTMLButtonElement>('[data-long-message-toggle]')
    expect(viewport?.style.maxHeight).toBe('500px')
    expect(toggle?.textContent).toContain('Read more')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle?.click())
    expect(viewport?.style.maxHeight).toBe('')
    expect(toggle?.textContent).toContain('Show less')
    expect(useStore.getState().expandedLongMessageKeys).toContain('chat-1:message-1')

    setRenderedBodyHeight(950)
    await flushLayout()
    expect(toggle?.textContent).toContain('Show less')

    await act(async () => toggle?.click())
    expect(viewport?.style.maxHeight).toBe('500px')
    expect(toggle?.textContent).toContain('Read more')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(useStore.getState().expandedLongMessageKeys).not.toContain('chat-1:message-1')
  })

  test('does not constrain short assistant messages or any user message', async () => {
    await act(async () => {
      root?.render(
        <MessageContent content="Short" isUser={false} userName="User" chatId="chat-1" messageId="short" />,
      )
    })
    const shortBody = setRenderedBodyHeight(220)
    await act(async () => {
      shortBody.dispatchEvent(new Event('load', { bubbles: true }))
      await new Promise((resolve) => domWindow.setTimeout(resolve, 20))
    })
    expect(host.querySelector('[data-long-message-toggle]')).toBeNull()

    await act(async () => {
      root?.render(
        <MessageContent content={'Long user content '.repeat(80)} isUser userName="User" chatId="chat-1" messageId="user-1" />,
      )
    })
    const userBody = setRenderedBodyHeight(900)
    await act(async () => {
      userBody.dispatchEvent(new Event('load', { bubbles: true }))
      await new Promise((resolve) => domWindow.setTimeout(resolve, 20))
    })
    const viewport = host.querySelector<HTMLElement>('[data-component="MessageContent"] > div')
    expect(viewport?.style.maxHeight).toBe('')
    expect(host.querySelector('[data-long-message-toggle]')).toBeNull()
  })

  test('uses every preset height and honors the disabled setting', async () => {
    const presets = [
      ['compact', 300],
      ['comfortable', 500],
      ['tall', 800],
    ] as const

    for (const [preset, height] of presets) {
      await act(async () => {
        useStore.setState({
          longMessageCollapseEnabled: true,
          longMessageCollapsePreset: preset,
          expandedLongMessageKeys: [],
        })
        root?.render(
          <MessageContent
            content={'Long assistant content '.repeat(80)}
            isUser={false}
            userName="User"
            chatId="chat-1"
            messageId={`preset-${preset}`}
          />,
        )
      })
      setRenderedBodyHeight(900)
      await flushLayout()

      const viewport = host.querySelector<HTMLElement>('[data-component="MessageContent"] > div')
      expect(viewport?.style.maxHeight).toBe(`${height}px`)
      expect(host.querySelector('[data-long-message-toggle]')).not.toBeNull()
    }

    await act(async () => {
      useStore.setState({ longMessageCollapseEnabled: false, expandedLongMessageKeys: [] })
      root?.render(
        <MessageContent
          content={'Long assistant content '.repeat(80)}
          isUser={false}
          userName="User"
          chatId="chat-1"
          messageId="disabled"
        />,
      )
    })
    setRenderedBodyHeight(900)
    await flushLayout()

    const viewport = host.querySelector<HTMLElement>('[data-component="MessageContent"] > div')
    expect(viewport?.style.maxHeight).toBe('')
    expect(host.querySelector('[data-long-message-toggle]')).toBeNull()
  })
})
