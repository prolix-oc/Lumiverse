/// <reference types="bun-types" />

import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { JSDOM } from 'jsdom'
let registerDisplayResolver: typeof import('@/lib/spindle/display-resolver-registry').registerDisplayResolver
let unregisterDisplayResolver: typeof import('@/lib/spindle/display-resolver-registry').unregisterDisplayResolver
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { default as MessageContentType } from './MessageContent'
import {
  getChatDisplaySettleDiagnostics,
  isChatDisplaySettled,
  resetChatDisplaySettleForTests,
} from '@/lib/chatDisplaySettle'
import {
  reconcileMessageTagRuntimeCapabilities,
  resetMessageTagRuntimeReadinessForTests,
} from '@/lib/spindle/message-tag-runtime-readiness'

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
  HTMLImageElement: domWindow.HTMLImageElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  DOMParser: domWindow.DOMParser,
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
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))

let createRoot: typeof CreateRoot
let MessageContent: typeof MessageContentType
let useStore: typeof import('@/store').useStore
let act: typeof import('react').act
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

beforeAll(async () => {
  ;({ registerDisplayResolver, unregisterDisplayResolver } = await import('@/lib/spindle/display-resolver-registry'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: MessageContent } = await import('./MessageContent'))
  ;({ useStore } = await import('@/store'))
  ;({ act } = await import('react'))
})

beforeEach(() => {
  reconcileMessageTagRuntimeCapabilities([])
  resetChatDisplaySettleForTests()
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
  resetChatDisplaySettleForTests()
  resetMessageTagRuntimeReadinessForTests()
})

describe('MessageContent inline HTML rendering', () => {
  test('formatting exemption follows the registered owner and is removed on disposal', async () => {
    const resolver = { skipFormattingHealing: true, ready: () => true,
      resolveBody: async () => null, resolveTemplates: async () => null, applyScripts: async () => null }
    useStore.setState({ activeChatId: 'format-chat', activeChatDisplayOwner: 'format-owner' })
    let dispose: (() => void) | undefined
    try {
      await act(async () => { root?.render(<MessageContent content='Before * padded * after' isUser={false} userName="User" chatId="format-chat" disableInterceptors />) })
      expect(host.querySelector('em')).not.toBeNull()
      await act(async () => { dispose = registerDisplayResolver('format-owner', resolver) })
      expect(host.querySelector('em')).toBeNull()
      expect(host.textContent).toContain('* padded *')
      await act(async () => { useStore.setState({ activeChatDisplayOwner: 'other-owner' }) })
      expect(host.querySelector('em')).not.toBeNull()
      await act(async () => { useStore.setState({ activeChatDisplayOwner: 'format-owner' }) })
      expect(host.querySelector('em')).toBeNull()
      await act(async () => { dispose?.() })
      expect(host.querySelector('em')).not.toBeNull()
    } finally {
      unregisterDisplayResolver('format-owner')
      useStore.setState({ activeChatId: null, activeChatDisplayOwner: null })
    }
  })

  function inlineScene(count: number) {
    return `<div class="scene">${Array.from({ length: count }, (_, i) => `<span style="top:${i}px">Actor ${i}</span>`).join('')}<img src="https://images.example/scene.png"></div>`
  }

  async function render(content: string, isStreaming = false) {
    await act(async () => {
      root?.render(<MessageContent content={content} isUser={false} userName="User" isStreaming={isStreaming} disableInterceptors />)
    })
  }

  test('keeps adjacent buttons with trailing class whitespace as HTML', async () => {
    await render('<div class="grid"><div class="btn " risu-btn="one">One</div><div class="btn active" risu-btn="two">Two</div></div>')
    expect(host.querySelectorAll('.btn')).toHaveLength(2)
    expect(host.querySelector('[risu-btn="one"]')?.textContent).toBe('One')
    expect(host.textContent).not.toContain('<div')
  })

  test.each([0, 1, 2, 3, 4, 8])('keeps %i inline styles reachable by document selectors', async (count) => {
    await render(inlineScene(count))

    expect(host.querySelectorAll('[data-lumiverse-html-island]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-lumiverse-inline-html-card]')).toHaveLength(count >= 3 ? 1 : 0)
    expect(host.querySelectorAll('.scene > span[style]')).toHaveLength(count)
    expect(host.querySelector('.scene > img')).not.toBeNull()
  })

  test('restores spacing around a mid-message inline card without isolating it', async () => {
    await render(`Before\n\n${inlineScene(3)}\n\nAfter`)

    const shell = host.querySelector<HTMLElement>('[data-lumiverse-inline-html-card]')
    expect(shell?.firstElementChild).toBe(host.querySelector('.scene'))
    expect(shell?.shadowRoot).toBeNull()
    expect(host.querySelectorAll('.scene > span[style]')).toHaveLength(3)
    expect(host.textContent).toContain('Before')
    expect(host.textContent).toContain('After')
  })

  test('keeps document selectors working across style-count changes while streaming', async () => {
    await render(inlineScene(2), true)
    const image = host.querySelector('.scene > img')
    const prose = host.querySelector('.scene')?.parentElement

    for (const count of [3, 8, 1]) {
      await render(inlineScene(count), true)
      expect(host.querySelectorAll('[data-lumiverse-html-island]')).toHaveLength(0)
      expect(host.querySelectorAll('[data-lumiverse-inline-html-card]')).toHaveLength(count >= 3 ? 1 : 0)
      expect(host.querySelectorAll('.scene > span[style]')).toHaveLength(count)
      expect(host.querySelector('.scene')?.parentElement).toBe(prose)
      expect(prose?.hasAttribute('data-lumiverse-inline-html-card')).toBe(count >= 3)
      expect(host.querySelector('.scene > img') === image).toBe(true)
    }
    await render(inlineScene(1))
    expect(host.querySelectorAll('.scene > span[style]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-lumiverse-inline-html-card]')).toHaveLength(0)
    expect(host.querySelector('.scene > img') === image).toBe(true)
  })

  test.each([
    '<div><style>.widget { color: red }</style><span class="widget">Widget</span></div>',
    '<html><body><div style="color:red">Document</div></body></html>',
  ])('preserves existing stylesheet and document isolation: %s', async (content) => {
    await render(content)
    expect(host.querySelectorAll('[data-lumiverse-html-island]')).toHaveLength(1)
    expect(host.querySelector('[data-lumiverse-html-island]')?.shadowRoot?.textContent).toContain(
      content.includes('Widget') ? 'Widget' : 'Document',
    )
  })
})

describe('HTML island scanning', () => {
  test.each(['\n', '\r\n', '\r'])('preserves fenced HTML offsets with %j line endings', async (newline) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const prefix = 'x'.repeat(4096) + newline
    const literal = ['```html', '<div><style>.literal{color:red}</style>Literal</div>', '```', ''].join(newline)
    const widget = '<div><style>.widget{color:blue}</style>Widget</div>'
    for (const streaming of [false, true]) {
      expect(extractHtmlIslands(prefix + literal + widget, streaming)).toEqual({
        content: prefix + literal + '<!--LUMIVERSE_HTML_ISLAND_0-->',
        islands: [widget],
      })
      expect(extractHtmlIslands(prefix + literal.slice(0, literal.lastIndexOf('```')), streaming).islands).toEqual([])
    }
  })

  test('preserves fenced HTML across mixed line endings', async () => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const raw = 'before\r\n~~~html\r<div><style>.x{color:red}</style>X</div>\n~~~\r\nafter'
    expect(extractHtmlIslands(raw, false)).toEqual({ content: raw, islands: [] })
  })

  test.each(['\u2028', '\u2029'])('keeps Unicode separator %j inside a Markdown line', async (separator) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const prefix = 'x'.repeat(4096) + separator + '```html\n'
    const widget = '<div><style>.widget{color:blue}</style>Widget</div>'
    expect(extractHtmlIslands(prefix + widget, false)).toEqual({
      content: prefix + '<!--LUMIVERSE_HTML_ISLAND_0-->',
      islands: [widget],
    })
  })

  test.each([2, 32, 128])('does not repeat %i nested islands containing fenced code', async (depth) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const block = '<div><style></style>\n```\nx\n```\n'.repeat(depth) + '</div>'.repeat(depth)
    const tail = '<p>tail</p>'
    for (const streaming of [false, true]) {
      expect(extractHtmlIslands(block + tail, streaming)).toEqual({
        content: '<!--LUMIVERSE_HTML_ISLAND_0-->' + tail,
        islands: [block],
      })
    }
  })

  test.each(['```', '~~~'])('keeps later %s fences literal after consuming an island', async (fence) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const block = `<div><style></style>\n${fence}\nx\n${fence}\n</div>`
    const literal = `\n${fence}html\n<section><style>.literal{color:red}</style></section>\n${fence}\n`
    const next = '<div><style>.next{color:blue}</style>Next</div>'
    for (const streaming of [false, true]) {
      expect(extractHtmlIslands(block + literal + next, streaming)).toEqual({
        content: '<!--LUMIVERSE_HTML_ISLAND_0-->' + literal + '<!--LUMIVERSE_HTML_ISLAND_1-->',
        islands: [block, next],
      })
    }
  })

  test.each([false, true])('preserves the rest of a fence ending outside its island (closed=%s)', async (closed) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const block = '<div><style></style>\n```html\n</div>'
    const tail = '\n<section><style>.literal{color:red}</style></section>' + (closed ? '\n```\n<p>tail</p>' : '')
    for (const streaming of [false, true]) {
      expect(extractHtmlIslands(block + tail, streaming)).toEqual({
        content: '<!--LUMIVERSE_HTML_ISLAND_0-->' + tail,
        islands: [block],
      })
    }
  })

  test.each([
    ['<div><span></div>text<style>x</style></span>', ['<span></div>text<style>x</style></span>']],
    ['<div title="<div>">Text</div><style>x</style>', ['<div title="<div>">Text</div><style>x</style>']],
    ['<div data-no-island><span>x</span></div><style>x</style>', ['<span>x</span></div><style>x</style>']],
    ['```html\n<style>x</style>\n```\n<div style="color:red">Text</div>', []],
    ['<html><body><div style="color:red">Text</div></body></html>', ['<html><body><div style="color:red">Text</div></body></html>']],
  ] as const)('preserves existing boundaries for %s', async (raw, islands) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    for (const streaming of [false, true]) {
      let content: string = raw
      for (const [i, island] of islands.entries()) content = content.replace(island, `<!--LUMIVERSE_HTML_ISLAND_${i}-->`)
      expect(extractHtmlIslands(raw, streaming)).toEqual({ content, islands: [...islands] })
    }
  })

  test.each(['before', 'after', 'fenced'] as const)('bounds repeated matching with a stylesheet %s nested HTML', async (position) => {
    const { extractHtmlIslands } = await import('./MessageContent')
    const nativeExec = RegExp.prototype.exec
    const countMatches = (depth: number) => {
      const block = '<div style="padding:1px">'.repeat(depth) + 'Text' + '</div>'.repeat(depth)
      const style = '<style>.widget{color:red}</style>'
      const raw = position === 'before' ? style + '\n\nProse\n\n' + block
        : position === 'after' ? block + '\n\nProse\n\n' + style
          : '```html\n' + style + '\n```\n' + block
      let calls = 0
      const exec = spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
        calls++
        return nativeExec.call(this, input)
      })
      try {
        const result = extractHtmlIslands(raw, false)
        expect(result.islands).toEqual(position === 'fenced' ? [] : [style])
      } finally { exec.mockRestore() }
      return calls
    }
    expect(countMatches(512)).toBeLessThan(countMatches(64) * 12)
  })

  test.each([
    ['missing opening end', '<div '.repeat(128) + '<style '],
    ['missing style end', '<style>'.repeat(128)],
    ['unfinished tag name', '<' + 'a-'.repeat(128) + '<style '],
    ['unfinished nested tags', '<div>' + '<div '.repeat(128) + '<style '],
  ])('bounds failed searches in unfinished streamed HTML: %s', async (_name, raw) => {
      const { extractHtmlIslands } = await import('./MessageContent')
      const nativeExec = RegExp.prototype.exec
      const nativeIndexOf = String.prototype.indexOf
      let searched = 0
      const exec = spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
        if (this.source === '<\\/style\\s*>' || this.source.includes('[^>]*>')) searched += input.length - this.lastIndex
        return nativeExec.call(this, input)
      })
      const indexOf = spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search: string, position = 0) {
        const result = nativeIndexOf.call(this, search, position)
        if (search === '>') searched += (result < 0 ? this.length : result + 1) - position
        return result
      })
      try {
        expect(extractHtmlIslands(raw, true)).toEqual({ content: raw, islands: [] })
        expect(searched).toBeLessThan(raw.length * 8)
      } finally {
        exec.mockRestore()
        indexOf.mockRestore()
      }
    },
  )
})

describe('MessageContent long-message collapsing', () => {
  test('does not hold the chat reveal for an inline image still loading', async () => {
    await act(async () => {
      root?.render(
        <MessageContent
          content={'![slow image](https://images.example/slow-generated-scene.png)'}
          isUser={false}
          userName="User"
          chatId="chat-images"
          messageId="inline-image-message"
        />,
      )
    })

    expect(host.querySelector<HTMLImageElement>('img[src*="images.example"]')).not.toBeNull()
    await act(async () => {
      await new Promise((resolve) => domWindow.setTimeout(resolve, 20))
    })
    expect(getChatDisplaySettleDiagnostics('chat-images').blockers).toEqual([])
    expect(isChatDisplaySettled('chat-images')).toBe(true)
  })

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
    expect(toggle?.textContent).toBe('Read more')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle?.click())
    expect(viewport?.style.maxHeight).toBe('')
    expect(toggle?.textContent).toBe('Show less')
    expect(useStore.getState().expandedLongMessageKeys).toContain('chat-1:message-1')

    setRenderedBodyHeight(950)
    await flushLayout()
    expect(toggle?.textContent).toBe('Show less')

    await act(async () => toggle?.click())
    expect(viewport?.style.maxHeight).toBe('500px')
    expect(toggle?.textContent).toBe('Read more')
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

describe('MessageContent image reuse', () => {
  for (const island of [false, true]) {
    const imageRoot = () => island ? host.firstElementChild!.shadowRoot! : host
    const render = async (html: string) => {
      const { ProseHtml, IsolatedHtml } = await import('./MessageContent')
      await act(async () => {
        root?.render(island ? <IsolatedHtml html={html} isStreaming={false} /> : <ProseHtml html={html} />)
      })
    }
    test(`skips unchanged image attributes when surrounding ${island ? 'island' : 'prose'} content changes`, async () => {
      await render('<p>Before</p><img src="/scene.png" class="scene" alt="Scene" width="400">')
      const original = imageRoot().querySelector('img')!
      const readAttribute = original.getAttribute.bind(original)
      const reads: string[] = []
      original.getAttribute = name => {
        reads.push(name)
        return readAttribute(name)
      }

      await render('<p>After</p><img width="400" alt="Scene" class="scene" src="/scene.png">')
      expect(imageRoot().querySelector('img')).toBe(original)
      expect(imageRoot().querySelector('p')?.textContent).toBe('After')
      expect(reads.filter(name => name !== 'src')).toEqual([])
    })

    test(`updates reused image attributes in ${island ? 'islands' : 'prose'}`, async () => {
      await render('<img src="/scene.png" class="preview" style="height:20px" alt="Old" data-lightbox>')
      const original = imageRoot().querySelector('img')!
      const changes: MutationRecord[] = []
      const attributes = new MutationObserver(records => changes.push(...records))
      attributes.observe(original, { attributes: true })

      await render('<div class="frame"><img src="/scene.png" class="scene" style="position:absolute;bottom:3%;height:60%" alt="New" width="400" data-role="background"></div>')
      const updated = imageRoot().querySelector('img')!
      expect(updated).toBe(original)
      expect(updated.className).toBe('scene')
      expect(updated.style.position).toBe('absolute')
      expect(updated.style.bottom).toBe('3%')
      expect(updated.style.height).toBe('60%')
      expect(updated.alt).toBe('New')
      expect(updated.getAttribute('width')).toBe('400')
      expect(updated.getAttribute('data-role')).toBe('background')
      expect(updated.hasAttribute('data-lightbox')).toBe(false)
      changes.push(...attributes.takeRecords())
      expect(changes.some(record => record.attributeName === 'class')).toBe(true)
      expect(changes.some(record => record.attributeName === 'src')).toBe(false)
      attributes.disconnect()

      await render('<img src="/scene.png">')
      expect(imageRoot().querySelector('img')).toBe(original)
      expect(original.hasAttribute('class')).toBe(false)
      expect(original.hasAttribute('style')).toBe(false)
      expect(original.hasAttribute('width')).toBe(false)
      expect(original.hasAttribute('data-role')).toBe(false)

      await render('<img src="/other.png" class="other">')
      expect(imageRoot().querySelector('img')).not.toBe(original)
    })

    test(`retains distinct attributes for repeated sources in ${island ? 'islands' : 'prose'}`, async () => {
      await render('<img src="/sprite.png" class="idle"><img src="/sprite.png" class="hover">')
      const original = imageRoot().querySelector('img')!
      await render('<img src="/sprite.png" class="front"><img src="/sprite.png" class="back">')
      const images = imageRoot().querySelectorAll('img')
      expect(images).toHaveLength(2)
      expect(images[0]).toBe(original)
      expect(images[0]!.className).toBe('front')
      expect(images[1]!.className).toBe('back')
      expect(images[0]).not.toBe(images[1])
    })
  }
})

describe('MessageContent island whitespace', () => {
  test.each([' ', '\t', '\u00a0', '\u2028'])('preserves whitespace in block and inline island text: %j', async (gap) => {
    const text = ' \ta' + gap.repeat(128) + 'b\t '
    const content = `<div><style>.text{white-space:pre-wrap}</style><div class="block text">${text}</div><span class="inline text">${text}</span></div>`
    await act(async () => { root?.render(<MessageContent content={content} isUser={false} userName="User" disableInterceptors />) })
    const island = host.querySelector('[data-lumiverse-html-island]')?.shadowRoot
    expect(island?.querySelector('.block')?.textContent).toBe(text)
    expect(island?.querySelector('.inline')?.textContent).toBe(text)
  })
})


describe('owned display spacing', () => {
  test('follows ownership, registration, revocation and streaming without changing default spacing', async () => {
    const { revokeInlineCardWrappingOptOut } = await import('@/lib/spindle/display-resolver-registry')
    const resolver = { skipInlineCardWrapping: true, ready: () => true,
      resolveBody: async () => null, resolveTemplates: async () => null, applyScripts: async () => null }
    const scene = (count: number) => `<div></div><input id="panel-toggle" type="checkbox"><label for="panel-toggle">Toggle</label><div class="panel"><img src="/panel.png">${'<span style="color:red">x</span>'.repeat(count)}</div>`
    const render = async (content = scene(3), chatId = 'padding-chat', isStreaming = false) => {
      await act(async () => { root?.render(<MessageContent content={content} chatId={chatId} isStreaming={isStreaming} isUser={false} userName="User" disableInterceptors />) })
    }
    const wrapped = () => host.querySelector('[data-lumiverse-inline-html-card]') !== null
    useStore.setState({ activeChatId: 'padding-chat', activeChatDisplayOwner: 'padding-owner' })
    try {
      await render()
      expect(wrapped()).toBe(true)
      const image = host.querySelector('img')
      let dispose: () => void = () => {}
      await act(async () => { dispose = registerDisplayResolver('padding-owner', resolver) })
      expect(wrapped()).toBe(false)
      await act(async () => { host.querySelector<HTMLLabelElement>('label')!.click() })
      expect(host.querySelector('#panel-toggle:checked ~ .panel')).not.toBeNull()
      expect(host.querySelector('img')).toBe(image)
      for (const count of [2, 3, 8, 1]) {
        await render(scene(count), 'padding-chat', true)
        expect(wrapped()).toBe(false)
        expect(host.querySelector('#panel-toggle ~ .panel')).not.toBeNull()
        expect(host.querySelector('img')).toBe(image)
      }
      await render()
      await act(async () => { useStore.setState({ activeChatDisplayOwner: 'other-owner' }) })
      expect(wrapped()).toBe(true)
      await act(async () => { useStore.setState({ activeChatDisplayOwner: 'padding-owner' }) })
      expect(wrapped()).toBe(false)
      await render(scene(3), 'other-chat')
      expect(wrapped()).toBe(true)
      await render()
      await act(async () => { revokeInlineCardWrappingOptOut('other-owner') })
      expect(wrapped()).toBe(false)
      await act(async () => { revokeInlineCardWrappingOptOut('padding-owner') })
      expect(wrapped()).toBe(true)
      await act(async () => { registerDisplayResolver('padding-owner', resolver); dispose() })
      expect(wrapped()).toBe(false)
      await act(async () => { unregisterDisplayResolver('padding-owner') })
      expect(wrapped()).toBe(true)
      await act(async () => { registerDisplayResolver('padding-owner', { ...resolver, skipInlineCardWrapping: false }) })
      expect(wrapped()).toBe(true)
      const single = '<div class="single" style="color:red"><i style="color:red"></i><b style="color:red"></b></div>'
      await render(single)
      const prose = host.querySelector('.single')!.parentElement!
      expect(prose.hasAttribute('data-lumiverse-inline-html-card')).toBe(true)
      await act(async () => { registerDisplayResolver('padding-owner', resolver) })
      expect(host.querySelector('.single')!.parentElement).toBe(prose)
      expect(prose.hasAttribute('data-lumiverse-inline-html-card')).toBe(false)
      await render('<div><style>.island{color:red}</style><span class="island">Island</span></div>')
      expect(host.querySelector('[data-lumiverse-html-island]')?.shadowRoot?.querySelector('.island')).not.toBeNull()
    } finally {
      await act(async () => { unregisterDisplayResolver('padding-owner'); useStore.setState({ activeChatId: null, activeChatDisplayOwner: null }) })
    }
  })
})
