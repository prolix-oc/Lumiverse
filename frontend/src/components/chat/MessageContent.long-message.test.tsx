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
  applyLoginLanguage: async () => {},
  changeLoginLanguage: async () => {},
  ensureLanguageLoaded: async () => {},
  initI18n: async () => ({ t: translate }),
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
}))
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
// The real store imports Whistle through the Spindle loader. Bun does not
// transform Vite worker URLs, and these rendering tests never start capture.
mock.module('@/lib/whistle/capture.worklet.ts?worker&url', () => ({
  default: '/test-capture-worklet.js',
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

describe('MessageContent display readiness', () => {
  test.each(['Unchanged ordinary text', '<div><style>p{color:purple}</style><p>Unchanged HTML</p></div>'])(
    'notifies the row when processing finishes without changing its content: %s', async content => {
      const previous = useStore.getState()
      const pending = Promise.withResolvers<{ content: string }>()
      const events: Array<{ ready: boolean; pending: boolean }> = []
      const record = (event: Event) => {
        const detail = (event as CustomEvent).detail
        if (detail?.displayReady) events.push({ ready: true, pending: host.querySelector('[data-display-pending]') !== null })
      }
      host.addEventListener('lumiverse:message-content-layout', record)
      useStore.setState({ activeChatId: 'ready-chat', activeChatDisplayOwner: 'ready-owner', messages: [], regexScripts: [] })
      const dispose = registerDisplayResolver('ready-owner', {
        ready: () => true, finalizeWithoutScripts: true,
        resolveBody: () => pending.promise,
        resolveTemplates: async ({ templates }) => ({ resolved: templates }),
        applyScripts: async ({ content }) => ({ content }),
      })
      try {
        const { resetDisplayRegexCachesForTests } = await import('@/hooks/useDisplayRegex')
        resetDisplayRegexCachesForTests()
        await act(async () => { root?.render(<MessageContent content={content} chatId="ready-chat" messageId="ready-message" isUser={false} userName="Reader" />) })
        expect(host.querySelector('[data-display-pending]')).not.toBeNull()
        // Provisional source must never enter the rendered tree, including
        // authored HTML whose descendants override inherited visibility.
        expect(host.textContent).not.toContain('Unchanged')
        expect(host.querySelector('[data-lumiverse-html-island]')).toBeNull()
        expect(events).toEqual([])
        await act(async () => { pending.resolve({ content }); await Promise.resolve() })
        for (let i = 0; i < 10 && host.querySelector('[data-display-pending]'); i++) await flushLayout()
        expect(host.querySelector('[data-display-pending]')).toBeNull()
        expect(events).toEqual([{ ready: true, pending: false }])
      } finally {
        await act(async () => {
          root?.unmount(); root = null; dispose()
          useStore.setState({ activeChatId: previous.activeChatId, activeChatDisplayOwner: previous.activeChatDisplayOwner, messages: previous.messages, regexScripts: previous.regexScripts })
        })
        host.removeEventListener('lumiverse:message-content-layout', record)
      }
    },
  )
})

describe('MessageContent inline HTML rendering', () => {
  test('action activation identifies displayed captures while retaining configured effect templates', async () => {
    const { REGEX_ACTION_EVENT } = await import('@/lib/regex/actionBus')
    const { regexActionSignature } = await import('../../../../src/utils/regex-action-signature')
    const payload = { id: 'go', scriptId: 'capture-rule', instanceId: 'capture-rule:0:6', type: 'send', multi_select: false,
      cost: 1, limit: 0, content: 'Take north', title: '', subtitle: '', effects: [{ type: 'set_state', key: 'route', value: 'north' }] }
    const configured = { ...payload, content: 'Take $1', effects: [{ type: 'set_state', key: 'route', value: '$1' }] }
    const html = `<button data-lumiverse-regex-action="${encodeURIComponent(JSON.stringify(payload))}">North</button>`
    const previous = useStore.getState()
    const activations: any[] = []
    const record = (event: Event) => activations.push((event as CustomEvent).detail)
    window.addEventListener(REGEX_ACTION_EVENT, record)
    useStore.setState({ activeChatId: 'capture-chat', activeChatDisplayOwner: 'capture-owner',
      messages: [{ id: 'capture-message', content: 'choice', is_user: false, swipe_id: 0, swipes: ['choice'] }] as any,
      regexScripts: [{ id: 'capture-rule', disabled: false, scope: 'global', target: ['display'], placement: ['ai_output'], find_regex: 'choice',
        replace_string: '', flags: 'g', substitute_macros: 'none', trim_strings: [], min_depth: null, max_depth: null, actions: [configured] }] as any,
    })
    const dispose = registerDisplayResolver('capture-owner', { ready: () => true,
      resolveBody: async () => ({ content: 'choice' }), resolveTemplates: async () => ({ resolved: {} }), applyScripts: async () => ({ content: html }) })
    try {
      await act(async () => { root?.render(<MessageContent content="choice" isUser={false} userName="Reader" chatId="capture-chat" messageId="capture-message" />) })
      const findAction = () => host.querySelector<HTMLButtonElement>('button[data-lumiverse-regex-action]')
        ?? host.querySelector('[data-lumiverse-html-island]')?.shadowRoot?.querySelector<HTMLButtonElement>('button[data-lumiverse-regex-action]')
      for (let i = 0; i < 40 && !findAction(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      expect(findAction()).toBeTruthy()
      findAction()!.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, composed: true }))
      expect(activations).toHaveLength(1)
      expect(activations[0].actionSignature).toBe(regexActionSignature(payload))
      expect(activations[0].effects).toEqual(configured.effects)
    } finally {
      await act(async () => {
        root?.unmount(); root = null; dispose()
        window.removeEventListener(REGEX_ACTION_EVENT, record)
        useStore.setState({ activeChatId: previous.activeChatId, activeChatDisplayOwner: previous.activeChatDisplayOwner, messages: previous.messages, regexScripts: previous.regexScripts })
      })
    }
  })
  test('read-only previews resolve owned display but never deliver tags or activate regex actions', async () => {
    const { registerTagInterceptor } = await import('@/lib/spindle/message-interceptors')
    const { REGEX_ACTION_EVENT } = await import('@/lib/regex/actionBus')
    let delivered = 0
    let activations = 0
    const recordAction = () => { activations += 1 }
    window.addEventListener(REGEX_ACTION_EVENT, recordAction)
    const disposeTag = registerTagInterceptor('preview-tag-test', 'Preview test', { tagName: 'preview-test' }, () => { delivered += 1 })
    const payload = { id: 'continue', scriptId: 'preview-rule', instanceId: 'preview-instance', type: 'send', multi_select: false, cost: 1, limit: 0, content: 'Continue', title: '', subtitle: '' }
    const html = `<div><style>h2{color:purple}</style><h2>Resolved preview</h2><button data-lumiverse-regex-action="${encodeURIComponent(JSON.stringify(payload))}">Continue</button></div>`
    const source = '<preview-test>source</preview-test>'
    const bodies: string[] = []
    const previous = useStore.getState()
    useStore.setState({
      activeChatId: 'preview-chat', activeChatDisplayOwner: 'preview-owner',
      messages: [{ id: 'preview-message', content: source, is_user: false, swipe_id: 0, swipes: [source] }] as any,
      regexScripts: [{ id: 'preview-rule', name: 'Preview rule', disabled: false, scope: 'global', target: ['display'], placement: ['ai_output'], find_regex: 'source', replace_string: '', flags: 'g', substitute_macros: 'none', trim_strings: [], min_depth: null, max_depth: null, actions: [payload] }] as any,
    })
    const disposeResolver = registerDisplayResolver('preview-owner', {
      ready: () => true,
      resolveBody: async ({ content }) => { bodies.push(content); return { content: 'processed', processingState: 'preview' } },
      resolveTemplates: async () => ({ resolved: {} }),
      applyScripts: async () => ({ content: html }),
    })
    try {
      await act(async () => { root?.render(<MessageContent content={source} isUser={false} userName="Reader" chatId="preview-chat" messageId="preview-message" readOnly />) })
      for (let attempt = 0; attempt < 40 && !host.querySelector('[data-lumiverse-html-island]')?.shadowRoot?.querySelector('h2'); attempt += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      }
      const island = host.querySelector('[data-lumiverse-html-island]')?.shadowRoot
      expect(bodies).toContain(source)
      expect(island?.querySelector('h2')?.textContent).toBe('Resolved preview')
      const action = island?.querySelector<HTMLButtonElement>('button')
      expect(action?.getAttribute('aria-disabled')).toBe('true')
      action?.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, composed: true }))
      action?.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }))
      expect(activations).toBe(0)
      expect(delivered).toBe(0)
      setRenderedBodyHeight(1800)
      await flushLayout()
      expect(host.querySelector('[data-long-message-toggle]')).toBeNull()
      expect(useStore.getState().expandedLongMessageKeys).toEqual([])
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        disposeResolver()
        disposeTag()
        window.removeEventListener(REGEX_ACTION_EVENT, recordAction)
        useStore.setState({ activeChatId: previous.activeChatId, activeChatDisplayOwner: previous.activeChatDisplayOwner, messages: previous.messages, regexScripts: previous.regexScripts })
      })
    }
  })
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

    await act(async () => {
      await new Promise((resolve) => domWindow.setTimeout(resolve, 20))
    })
    expect(host.querySelector<HTMLImageElement>('img[src*="images.example"]')).not.toBeNull()
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
    const render = async (html: string, isStreaming = false) => {
      const { ProseHtml, IsolatedHtml } = await import('./MessageContent')
      await act(async () => {
        root?.render(island ? <IsolatedHtml html={html} isStreaming={isStreaming} /> : <ProseHtml html={html} />)
      })
    }
    test(`streamed ${island ? 'island' : 'prose'} text never detaches existing media or animation containers`, async () => {
      const frame = (tail: string) => '<style>.animated{animation:spin 1s infinite}</style>'
        + `<div class="animated"><img src="/animated.gif"><video src="/clip.webm"></video><span>${tail}</span></div>`
      await render(frame('one'), true)
      const container = imageRoot().querySelector<HTMLElement>('.animated')!
      const image = container.querySelector('img')!
      const video = container.querySelector('video')!
      const stylesheet = imageRoot().querySelector<HTMLStyleElement>('style:last-of-type')!
      const text = container.querySelector('span')!.firstChild
      const mutations: MutationRecord[] = []
      const observer = new MutationObserver(records => mutations.push(...records))
      observer.observe(imageRoot(), { subtree: true, childList: true, attributes: true, characterData: true })

      for (const tail of ['one two', 'one two three', 'final']) await render(frame(tail), true)
      await render(frame('final'), false)
      mutations.push(...observer.takeRecords())
      observer.disconnect()

      expect(imageRoot().querySelector<HTMLElement>('.animated')).toBe(container)
      expect(container.querySelector('img')).toBe(image)
      expect(container.querySelector('video')).toBe(video)
      expect(imageRoot().querySelector<HTMLStyleElement>('style:last-of-type')).toBe(stylesheet)
      expect(container.querySelector('span')!.firstChild).toBe(text)
      expect(text?.textContent).toBe('final')
      // Identity alone is insufficient: detach/reinsert also restarts media
      // and CSS animations. Streaming should produce text mutations only.
      expect(mutations.length).toBeGreaterThan(0)
      expect(mutations.every(record => record.type === 'characterData')).toBe(true)
    })

    test(`streaming preserves interaction state in ${island ? 'islands' : 'prose'} until source attributes change`, async () => {
      const frame = (tail: string, style = 'color:red') => `<details><summary>More</summary><input value="initial"><button style="${style}">Action</button><span>${tail}</span></details>`
      await render(frame('one'))
      const details = imageRoot().querySelector('details')!
      const input = imageRoot().querySelector('input')!
      const button = imageRoot().querySelector('button')!
      details.open = true
      input.value = 'user value'
      button.style.opacity = '0.5'

      await render(frame('one two'))
      expect(imageRoot().querySelector('details')).toBe(details)
      expect(details.open).toBe(true)
      expect(imageRoot().querySelector('input')).toBe(input)
      expect(input.value).toBe('user value')
      expect(button.style.opacity).toBe('0.5')

      await render(frame('one two three', 'color:blue'))
      expect(button.style.color).toBe('blue')
    })

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

describe('Streaming details completion', () => {
  test.each([
    ['<details><summary>Title', '<details><summary>Title</summary></details>'],
    ['<DETAILS open><SUMMARY>Title', '<DETAILS open><SUMMARY>Title</summary></details>'],
    ['<details><summary>Title</summary></details>', '<details><summary>Title</summary></details>'],
    ['</details><details>', '</details><details>'],
    ['<details <summary>', '<details <summary></details>'],
    ['<details title="a>b"><summary>', '<details title="a>b"><summary></summary></details>'],
    ['<detailsx><summary_extra>', '<detailsx><summary_extra>'],
    ['```\n<details><summary>\n```\n<summary>Title', '```\n<details><summary>\n```\n<summary>Title</summary>'],
    ['~~~\n<details>\n~~~\n<summary>Title', '~~~\n<details>\n~~~\n<summary>Title</summary>'],
    ['<details>\n```\n</details>\n```\n', '<details>\n```\n</details>\n```\n</details>'],
  ])('retains completion boundaries in %s', async (raw, expected) => {
    const { balanceStreamingDetails } = await import('./MessageContent')
    expect(balanceStreamingDetails(raw)).toBe(expected)
  })

  test('leaves many unfinished detail tags unchanged', async () => {
    const { balanceStreamingDetails } = await import('./MessageContent')
    const raw = '<details <summary '.repeat(256)
    expect(balanceStreamingDetails(raw)).toBe(raw)
    expect(balanceStreamingDetails(raw + '>')).toBe(raw + '></details>')
  })
})

describe('Trusted video extraction', () => {
  test('retains video attributes and the surrounding text', async () => {
    const { extractTrustedYouTubeEmbeds } = await import('./MessageContent')
    const raw = 'Before<IFRAME src="https://www.youtube-nocookie.com/embed/abcdef?autoplay=1&amp;start=4" title=" Example "></IFRAME \n>After'
    expect(extractTrustedYouTubeEmbeds(raw)).toEqual({
      content: 'Before<!--LUMIVERSE_YOUTUBE_EMBED_0-->After',
      embeds: [{ src: 'https://www.youtube-nocookie.com/embed/abcdef?autoplay=1&start=4', title: 'Example' }],
    })
  })

  test.each([
    'https://www.youtube-nocookie.com.evil.test/embed/abcdef',
    'https://www.youtube.com/embed/abcdef',
    'http://www.youtube-nocookie.com/embed/abcdef',
    'https://www.youtube-nocookie.com/embed/short',
    'https://www.youtube-nocookie.com/embed/abcdef#fragment',
    'https://www.youtube-nocookie.com/embed/abcdef?autoplay=2',
    'https://www.youtube-nocookie.com/embed/abcdef?start=1234567',
    'https://www.youtube-nocookie.com/embed/abcdef?unknown=1',
    'javascript:alert(1)',
  ])('leaves rejected video URL %s unchanged', async (src) => {
    const { extractTrustedYouTubeEmbeds } = await import('./MessageContent')
    const raw = `<iframe src="${src}"></iframe>`
    expect(extractTrustedYouTubeEmbeds(raw)).toEqual({ content: raw, embeds: [] })
  })

  test('leaves many unfinished video frames unchanged after a complete frame', async () => {
    const { extractTrustedYouTubeEmbeds } = await import('./MessageContent')
    const incomplete = '<iframe '.repeat(256)
    for (const ending of ['', '\n', '\r\n', '\u2028', '\u2029']) {
      expect(extractTrustedYouTubeEmbeds(incomplete + ending)).toEqual({ content: incomplete + ending, embeds: [] })
      const complete = '<iframe src="https://www.youtube-nocookie.com/embed/abcdef" title="Example"></iframe>'
      expect(extractTrustedYouTubeEmbeds(complete + incomplete + ending)).toEqual({
        content: '<!--LUMIVERSE_YOUTUBE_EMBED_0-->' + incomplete + ending,
        embeds: [{ src: 'https://www.youtube-nocookie.com/embed/abcdef', title: 'Example' }],
      })
    }
  })
})
describe('Image lazy loading', () => {
  test.each([
    ['<IMG src="/scene.png">', '<img loading="lazy" src="/scene.png">'],
    ['<img loading=eager>', '<img loading=eager>'],
    ['<img LOADING="lazy">', '<img LOADING="lazy">'],
    ['<img loading = eager>', '<img loading="lazy" loading = eager>'],
    ['<img data-loading=x>', '<img data-loading=x>'],
    ['<img title="loading=x">', '<img title="loading=x">'],
    ['<img title=">loading=x">', '<img loading="lazy" title=">loading=x">'],
    ['<img <IMG loading=x <IMG>', '<img <IMG loading=x <img loading="lazy">'],
    ['<imgx><img_name><img-ok>', '<imgx><img_name><img loading="lazy"-ok>'],
    ['<img\r\nsrc="/scene.png">', '<img loading="lazy"\r\nsrc="/scene.png">'],
  ])('preserves attribute handling in %s', async (html, expected) => {
    const { addLazyLoadingToImages } = await import('./MessageContent')
    expect(addLazyLoadingToImages(html)).toBe(expected)
  })

  test('handles many image prefixes before one closing delimiter', async () => {
    const { addLazyLoadingToImages } = await import('./MessageContent')
    const raw = '<img '.repeat(256)
    const expected = '<img loading="lazy" '.repeat(256)
    expect(addLazyLoadingToImages(raw)).toBe(expected)
    expect(addLazyLoadingToImages(raw + '>')).toBe(expected + '>')
    expect(addLazyLoadingToImages(raw + 'loading=eager>')).toBe(raw + 'loading=eager>')
  })

  test('does not replace images that already specify loading', async () => {
    const { addLazyLoadingToImages } = await import('./MessageContent')
    const raw = '<img src="/image.png" loading=eager>'.repeat(256)
    const nativeExec = RegExp.prototype.exec
    let replacements = 0
    const exec = spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
      const match = nativeExec.call(this, input)
      if (match?.[0].startsWith('<img')) replacements++
      return match
    })
    let output: string
    try {
      output = addLazyLoadingToImages(raw)
    } finally { exec.mockRestore() }
    expect(output).toBe(raw)
    expect(replacements).toBe(0)
  })
})
describe('Dialogue HTML boundaries', () => {
  test.each([
    ['<x<y>"word"', '<x<y><span class="dialogue">&quot;word&quot;</span>'],
    ['<x "word"', '<x <span class="dialogue">&quot;word&quot;</span>'],
    ['<x title="a>b">"word"', '<x title="a>b<span class="dialogue">&quot;>&quot;</span>word<span class="dialogue">&quot;</span>'],
    ['<code>"code"</code>"word"', '<code>"code"</code><span class="dialogue">&quot;word&quot;</span>'],
    ['<pre>"code"</pre>"word"', '<pre>"code"</pre><span class="dialogue">&quot;word&quot;</span>'],
    ['"start <strong>middle</strong> end"', '<span class="dialogue">&quot;start <strong>middle</strong> end&quot;</span>'],
    ['<p>"first</p><p>"next</p>', '<p><span class="dialogue">&quot;first</span></p><p><span class="dialogue">&quot;next</span></p>'],
  ])('preserves existing boundaries in %s', async (raw, expected) => {
    const { colorizeDialogue } = await import('./MessageContent')
    expect(colorizeDialogue(raw).replace(/class="[^"]*"/g, 'class="dialogue"')).toBe(expected)
  })

  test('keeps a long unfinished HTML tail as text', async () => {
    const { colorizeDialogue } = await import('./MessageContent')
    const tail = '<'.repeat(4096) + '"word"'
    const expected = '<'.repeat(4096) + '<span class="dialogue">&quot;word&quot;</span>'
    expect(colorizeDialogue(tail).replace(/class="[^"]*"/g, 'class="dialogue"')).toBe(expected)
    expect(colorizeDialogue('<code>"code"</code>' + tail).replace(/class="[^"]*"/g, 'class="dialogue"'))
      .toBe('<code>"code"</code>' + expected)
  })
})
describe('Dialogue measurement quotes', () => {
  test.each(["'", '&#39;', '&#00039;', '&#x27;', '&#X00027;', '&apos;', '&APOS;'])(
    'preserves a measurement written with %s', async (apostrophe) => {
      const { colorizeDialogue } = await import('./MessageContent')
      for (const quote of ['"', '&quot;']) {
        const raw = `Height 5${apostrophe}11${quote}.`
        expect(colorizeDialogue(raw)).toBe(`Height 5${apostrophe}11&quot;.`)
      }
    },
  )

  test.each(["five'11", "5'", "5'Ù¡", '5&#38;11', '5&#03911', '5&aposx;11', '5&amp;apos;11'])(
    'keeps a dialogue quote after %s', async (prefix) => {
      const { colorizeDialogue } = await import('./MessageContent')
      expect(colorizeDialogue(`${prefix}"hello"`).replace(/class="[^"]*"/g, 'class="dialogue"'))
        .toBe(`${prefix}<span class="dialogue">&quot;hello&quot;</span>`)
    },
  )

  test('does not copy the accumulated message before every quote', async () => {
    const { colorizeDialogue } = await import('./MessageContent')
    const raw = 'prefix '.repeat(256) + '"word" '.repeat(256)
    let inspectedLength = 0
    const originalSlice = String.prototype.slice
    const slice = spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start?: number, end?: number) {
      const result = originalSlice.call(this, start, end)
      inspectedLength += result.length
      return result
    })
    try {
      colorizeDialogue(raw)
    } finally {
      slice.mockRestore()
    }
    expect(inspectedLength).toBeLessThan(raw.length * 4)
  })
})

describe('HTML image asset resolution', () => {
  test.each([
    ['<img src="first" src="last">', '\n\n![last](/api/v1/images/last-id)\n\n'],
    ['<img src="first" src="https://example.com/image.png">', '<img src="first" src="https://example.com/image.png">'],
    ['<img src="/image.png"><img src="data:image/png;base64,x">', '<img src="/image.png"><img src="data:image/png;base64,x">'],
    ['<img src="missing" class="unchanged">', '<img src="missing" class="unchanged">'],
    ['<img src="folder/portrait.webp">', '\n\n![folder/portrait.webp](/api/v1/images/portrait-id)\n\n'],
    ['<img src="first\'>', '\n\n![first](/api/v1/images/first-id)\n\n'],
    ['<img src="a>b">', '\n\n![a>b](/api/v1/images/greater-id)\n\n'],
    ['<img src="first" src="later>value"', '\n\n![first](/api/v1/images/first-id)\n\nvalue"'],
    ['<img src="first src="last">', '\n\n![last](/api/v1/images/last-id)\n\n'],
  ])('preserves asset selection and surrounding text for %s', async (raw, expected) => {
    const { resolveImgSrcAssetTags } = await import('./MessageContent')
    expect(resolveImgSrcAssetTags(raw, { first: 'first-id', last: 'last-id', portrait: 'portrait-id', 'a>b': 'greater-id' })).toBe(expected)
  })

  test('uses the supplied asset map for every resolution', async () => {
    const { resolveImgSrcAssetTags } = await import('./MessageContent')
    const raw = '<img src="portrait">'
    expect(resolveImgSrcAssetTags(raw, { portrait: 'first-chat' })).toContain('/api/v1/images/first-chat')
    expect(resolveImgSrcAssetTags(raw, { portrait: 'second-chat' })).toContain('/api/v1/images/second-chat')
    expect(resolveImgSrcAssetTags(raw, {})).toBe(raw)
  })

  test('preserves unfinished images and later complete images', async () => {
    const { resolveImgSrcAssetTags } = await import('./MessageContent')
    const raw = '<img '.repeat(512) + 'src="a" '.repeat(512)
    expect(resolveImgSrcAssetTags(raw, { a: 'image-id' })).toBe(raw)
    expect(resolveImgSrcAssetTags(raw + '>tail<img src="a">', { a: 'image-id' })).toBe(
      '\n\n![a](/api/v1/images/image-id)\n\ntail\n\n![a](/api/v1/images/image-id)\n\n',
    )
  })
})

describe('Markdown image asset boundaries', () => {
  test.each([
    ['![a](portrait)', '![a](/api/v1/images/image-id)'],
    ['![![nested](portrait)', '![![nested](/api/v1/images/image-id)'],
    ['![]() ![a](portrait)', '![]() ![a](/api/v1/images/image-id)'],
    ['![a] x ![b](portrait)', '![a] x ![b](/api/v1/images/image-id)'],
    ['![a](missing) ![b](portrait)', '![a](missing) ![b](/api/v1/images/image-id)'],
    ['![a](https://example.com/x) ![b](/x) ![c](data:x)', '![a](https://example.com/x) ![b](/x) ![c](data:x)'],
    ['![a](portrait', '![a](portrait'],
    ['![a](portrait "title")', '![a](/api/v1/images/image-id)'],
  ])('preserves Markdown resolution for %s', async (raw, expected) => {
    const { resolveMarkdownImgTags } = await import('./MessageContent')
    expect(resolveMarkdownImgTags(raw, { portrait: 'image-id' })).toBe(expected)
  })

  test('keeps incomplete labels literal and still resolves a later complete image', async () => {
    const { resolveMarkdownImgTags } = await import('./MessageContent')
    const prefix = '!['.repeat(4096)
    expect(resolveMarkdownImgTags(prefix, { portrait: 'image-id' })).toBe(prefix)
    expect(resolveMarkdownImgTags(prefix + '] ordinary ![a](portrait)', { portrait: 'image-id' })).toBe(prefix + '] ordinary ![a](/api/v1/images/image-id)')
    expect(resolveMarkdownImgTags('![a](portrait)', {})).toBe('![a](portrait)')
  })
})

describe('Markdown image title whitespace', () => {
  test.each([
    ['![a](portrait "title")', '![a](/api/v1/images/image-id)'],
    ["![a](portrait \t'title')", '![a](/api/v1/images/image-id)'],
    ['![a](portrait "title\')', '![a](/api/v1/images/image-id)'],
    ['![a](portrait "")', '![a](/api/v1/images/image-id)'],
    ['![a](portrait "unfinished)', '![a](portrait "unfinished)'],
    ['![a](portrait "a"b")', '![a](portrait "a"b")'],
    ['![a](portrait"title")', '![a](portrait"title")'],
    ['![a](  portrait  )', '![a](/api/v1/images/image-id)'],
  ])('preserves title handling for %s', async (raw, expected) => {
    const { resolveMarkdownImgTags } = await import('./MessageContent')
    expect(resolveMarkdownImgTags(raw, { portrait: 'image-id' })).toBe(expected)
  })

  test('leaves long whitespace runs without a title unchanged', async () => {
    const { resolveMarkdownImgTags } = await import('./MessageContent')
    const raw = '![a](portrait' + ' '.repeat(8192) + 'x)'
    expect(resolveMarkdownImgTags(raw, { portrait: 'image-id' })).toBe(raw)
    expect(resolveMarkdownImgTags('![a](portrait' + ' '.repeat(8192) + '"title")', { portrait: 'image-id' })).toBe('![a](/api/v1/images/image-id)')
  })
})
