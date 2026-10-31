/// <reference types="bun-types" />

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { Root } from 'react-dom/client'
import type { Message } from '@/types/api'
import type { RegexScript } from '@/types/regex'

interface PipelineOutcome {
  result: string
  touchedVars: Set<string>
  cacheable: boolean
}

interface Identity {
  chatId: string
  messageId: string
}

interface HarnessProps {
  content: string
  depth?: number
  identity?: Identity
  isStreaming: boolean
  onCommit?: (state: { content: string; pending: boolean }) => void
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const domWindow = dom.window
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Node: domWindow.Node,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
})

const pendingResults = new Map<string, (outcome: PipelineOutcome) => void>()
const applyDisplayRegexTiered = mock((content: string, ..._args: unknown[]) => new Promise<PipelineOutcome>((resolve) => {
  pendingResults.set(content, resolve)
}))
const trackInitialDisplayResolve = mock(<T,>(promise: Promise<T>) => promise)
const storeState = {
  regexScripts: [{
    id: 'resolver-lifecycle-regex',
    name: 'Resolver lifecycle regex',
    target: ['display'],
    disabled: false,
    scope: 'global',
    scope_id: null,
    find_regex: 'chunk',
    replace_string: 'resolved',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    min_depth: null,
    max_depth: null as number | null,
    trim_strings: [],
    substitute_macros: 'none',
    metadata: {},
    updated_at: 1,
  }],
  activeCharacterId: 'resolver-lifecycle-character',
  activeGroupCharacterId: null,
  activeChatId: 'resolver-lifecycle-default-chat',
  activePersonaId: null,
  messages: [] as Message[],
}

mock.module('@/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))
mock.module('@/lib/chatDisplaySettle', () => ({
  trackInitialDisplayResolve,
}))
mock.module('@/lib/regex/pipeline', () => ({
  applyDisplayRegexTiered,
}))
mock.module('@/api/macros', () => ({
  resolveMacrosBatch: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }),
}))
/**
 * Display preprocessing is a pass-through resolver, except for contents parked
 * with `holdPreprocess`, whose round trip stays in flight until
 * `releasePreprocess`. That models the real gap between a store commit and the
 * preprocess response landing.
 */
const heldPreprocess = new Set<string>()
const pendingPreprocess = new Map<string, (value: { content: string; cacheable: boolean; processingState?: string }) => void>()
let finalizeWithoutScripts: boolean | undefined = true
const isDisplayChatOwnedMock = mock(() => true)
const ownedTemplateResolver = mock(async ({ templates, context }: { templates: Record<string, string>; context: { messageId?: string } }) => ({
  resolved: Object.fromEntries(Object.entries(templates).map(([key, value]) => [key,
    value === '{{getvar::template_marker}}' ? context.messageId ?? 'missing' : value])),
}))
const heldRemotePreprocess = new Set<string>()
const pendingRemotePreprocess = new Map<string, (response: Response) => void>()
const nativeFetch = globalThis.fetch

function remotePreprocessResponse(rawContents: string[]): Response {
  return new Response(JSON.stringify({
    items: rawContents.map((content) => ({ content, incrementalRawAppendSafe: true })),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
  const parsed = JSON.parse(String(init?.body ?? '{}')) as { items?: Array<{ rawContent?: string }> }
  const rawContents = (parsed.items ?? []).map((item) => item.rawContent ?? '')
  const held = rawContents.find((content) => heldRemotePreprocess.has(content))
  if (held) {
    return new Promise<Response>((resolve) => {
      pendingRemotePreprocess.set(held, resolve)
    })
  }
  return Promise.resolve(remotePreprocessResponse(rawContents))
})
globalThis.fetch = fetchMock as unknown as typeof fetch

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: isDisplayChatOwnedMock,
  getDisplayResolverForChat: () => ({
    finalizeWithoutScripts,
    resolveBody: ({ content }: { content: string }) => (
      heldPreprocess.has(content)
        ? new Promise<{ content: string; cacheable: boolean }>((resolvePreprocess) => {
            pendingPreprocess.set(content, resolvePreprocess)
          })
        : Promise.resolve({ content, cacheable: true })
    ),
    resolveTemplates: ownedTemplateResolver,
  }),
}))
const getPresetScripts = mock(async () => [{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset' }])
mock.module('@/api/regex', () => ({ regexApi: { getActive: getPresetScripts, reportPerformance: async () => undefined } }))
mock.module('@/lib/toast', () => ({ toast: { warning: () => undefined, error: () => undefined } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))

const {
  getDisplayContentCacheStatsForTests,
  invalidateDisplayRegexCache,
  resetDisplayRegexCachesForTests,
  useDisplayRegexState,
} = await import('./useDisplayRegex')
const { act, createElement, StrictMode, useLayoutEffect } = await import('react')
const { createRoot } = await import('react-dom/client')

function Harness({ content, depth = 0, identity, isStreaming, onCommit }: HarnessProps) {
  const rendered = useDisplayRegexState(
    content,
    false,
    depth,
    undefined,
    identity
      ? {
          chatId: identity.chatId,
          messageId: identity.messageId,
          role: 'assistant',
        }
      : undefined,
    isStreaming,
  )
  useLayoutEffect(() => { onCommit?.(rendered) })
  return createElement('output', { 'data-pending': rendered.pending }, rendered.content)
}

function readRendered(host: HTMLDivElement): string {
  return host.textContent ?? ''
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0))
  })
}

async function waitForPending(content: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && !pendingResults.has(content); attempt++) {
    await flushReact()
  }
  if (!pendingResults.has(content)) throw new Error(`Resolver did not start for ${content}`)
}

async function settle(content: string, result: string): Promise<void> {
  const resolve = pendingResults.get(content)
  if (!resolve) throw new Error(`No pending resolver for ${content}`)
  pendingResults.delete(content)
  await act(async () => {
    resolve({ result, touchedVars: new Set(), cacheable: true })
    await Promise.resolve()
  })
}

async function render(root: Root, props: HarnessProps): Promise<void> {
  await act(async () => { root.render(createElement(Harness, props)) })
  await waitForPending(props.content)
}

/** Commit a render whose preprocess round trip is still in flight. */
async function renderWhilePreprocessPending(root: Root, props: HarnessProps): Promise<void> {
  await act(async () => { root.render(createElement(Harness, props)) })
  for (let attempt = 0; attempt < 5; attempt++) await flushReact()
}

function holdPreprocess(content: string): void {
  heldPreprocess.add(content)
}

async function releasePreprocess(content: string, result = content, processingState?: string): Promise<void> {
  heldPreprocess.delete(content)
  const resolvePreprocess = pendingPreprocess.get(content)
  if (!resolvePreprocess) throw new Error(`No held preprocess for ${content}`)
  pendingPreprocess.delete(content)
  await act(async () => {
    resolvePreprocess({ content: result, cacheable: true, processingState })
    await Promise.resolve()
  })
}

async function createHarness(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  return { host, root: createRoot(host) }
}

async function destroyHarness(host: HTMLDivElement, root: Root): Promise<void> {
  await act(async () => root.unmount())
  host.remove()
  pendingResults.clear()
  resetDisplayRegexCachesForTests()
}

afterEach(() => {
  storeState.messages = []
  pendingResults.clear()
  heldPreprocess.clear()
  pendingPreprocess.clear()
  heldRemotePreprocess.clear()
  pendingRemotePreprocess.clear()
  isDisplayChatOwnedMock.mockImplementation(() => true)
  fetchMock.mockClear()
  applyDisplayRegexTiered.mockClear()
  getPresetScripts.mockClear()
  trackInitialDisplayResolve.mockClear()
  document.body.replaceChildren()
  resetDisplayRegexCachesForTests()
})

afterAll(() => {
  globalThis.fetch = nativeFetch
  dom.window.close()
})

describe('useDisplayRegex resolver lifecycle', () => {
  test('source template caches keep identical preset variables separate across messages', async () => {
    getPresetScripts.mockImplementationOnce(async () => [{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset',
      replace_string: '{{getvar::template_marker}}', substitute_macros: 'escaped' }])
    storeState.messages = ['first', 'second'].map(id => ({ id, chat_id: 'source-chat', index_in_chat: 0, is_user: false, name: 'Cat', content: `chunk ${id}`,
      send_date: 0, swipe_id: 0, swipes: [`chunk ${id}`], swipe_dates: [0], parent_message_id: null, branch_id: null, created_at: 0,
      extra: { spindle_metadata: { preset_contexts: [{ preset_id: 'source-preset', variables: { local: { same: 'value' } } }] } } }))
    const { host, root } = await createHarness()
    try {
      for (const id of ['first', 'second']) {
        await render(root, { content: `chunk ${id}`, identity: { chatId: 'source-chat', messageId: id }, isStreaming: false })
        await waitForPending(`chunk ${id}`)
        const context = applyDisplayRegexTiered.mock.calls.at(-1)?.[2] as { resolvedReplacements: Map<string, string> }
        expect(context.resolvedReplacements.get('source-only')).toBe(id)
        await settle(`chunk ${id}`, id)
      }
      expect(getPresetScripts).toHaveBeenCalledTimes(1)
    } finally { await destroyHarness(host, root) }
  })

  test('a swipe reuses its preset definitions and runs the existing worker pipeline without the active preset', async () => {
    isDisplayChatOwnedMock.mockImplementation(() => false)
    const raw = 'chunk scoped source'
    heldRemotePreprocess.add(raw)
    storeState.messages = [{ id: 'source-message', chat_id: 'source-chat', index_in_chat: 0, is_user: false, name: 'Cat', content: raw,
      send_date: 0, swipe_id: 0, swipes: [raw], swipe_dates: [0], parent_message_id: null, branch_id: null, created_at: 0,
      extra: { spindle_metadata: { preset_contexts: [{ preset_id: 'source-preset' }] } } }]
    const { host, root } = await createHarness()
    try {
      await act(async () => { root.render(createElement(Harness, { content: raw, identity: { chatId: 'source-chat', messageId: 'source-message' }, isStreaming: false })) })
      for (let i = 0; i < 20 && !pendingRemotePreprocess.has(raw); i++) await flushReact()
      await act(async () => {
        pendingRemotePreprocess.get(raw)!(Response.json({ items: [{ content: raw, incrementalRawAppendSafe: true }] }))
      })
      await waitForPending(raw)
      expect(applyDisplayRegexTiered.mock.calls).toHaveLength(1)
      expect((applyDisplayRegexTiered.mock.calls[0][1] as Array<{ id: string }>).map(s => s.id)).toEqual(['source-only'])
      await settle(raw, 'A:final')
      expect(readRendered(host)).toBe('A:final')
      expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('false')
      const next = `${raw} next`
      await render(root, { content: next, identity: { chatId: 'source-chat', messageId: 'source-message' }, isStreaming: false })
      expect(readRendered(host)).toBe('A:final')
      await settle(next, 'A:next')
      expect(readRendered(host)).toBe('A:next')
      expect(getPresetScripts).toHaveBeenCalledTimes(1)
    } finally { await destroyHarness(host, root) }
  })

  test('large preset definitions are shared across cached answer frames', async () => {
    isDisplayChatOwnedMock.mockImplementation(() => false)
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = Array.from({ length: 176 }, (_, index) => ({
      ...originalScripts[0],
      id: `large-preset-${index}`,
      replace_string: `<style>.card-${index}{color:red}</style><div>${'x'.repeat(1500)}</div>`,
    }))
    const { host, root } = await createHarness()
    try {
      for (let frame = 0; frame < 6; frame++) {
        const content = `chunk${' next'.repeat(frame)}`
        await render(root, { content, isStreaming: true })
        await settle(content, `card frame ${frame}`)
        expect(readRendered(host)).toBe(`card frame ${frame}`)
      }
      const stats = getDisplayContentCacheStatsForTests()
      expect(stats.size).toBe(6)
      // Sola-sized replacements used to be serialized into every cache key.
      expect(stats.keyCharacters).toBeLessThan(10_000)
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('oversized template results still resolve when the reuse cache rejects them', async () => {
    const replacement = '{{getvar::large}}' + 'x'.repeat(2 * 1024 * 1024)
    getPresetScripts.mockImplementationOnce(async () => [{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset',
      replace_string: replacement, substitute_macros: 'escaped' }])
    storeState.messages = [{ ...sourceMessage(), id: 'large-template' }]
    const { host, root } = await createHarness()
    try {
      await render(root, { content: 'chunk large template', identity: { chatId: 'source-chat', messageId: 'large-template' }, isStreaming: false })
      await waitForPending('chunk large template')
      const context = applyDisplayRegexTiered.mock.calls.at(-1)?.[2] as { resolvedReplacements: Map<string, string> }
      expect(context.resolvedReplacements.get('source-only')).toBe(replacement)
      await settle('chunk large template', 'fully resolved')
      expect(readRendered(host)).toBe('fully resolved')
      expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('false')
      expect(getDisplayContentCacheStatsForTests().templateSize).toBe(0)
    } finally { await destroyHarness(host, root) }
  })

  test('oversized bodies finish both display stages without requiring a cache entry', async () => {
    const content = 'chunk ' + 'x'.repeat(2 * 1024 * 1024)
    const { host, root } = await createHarness()
    try {
      await render(root, { content, identity: { chatId: 'source-chat', messageId: 'large-body' }, isStreaming: false })
      await waitForPending(content)
      await settle(content, 'large body resolved')
      expect(readRendered(host)).toBe('large body resolved')
      expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('false')
      expect(getDisplayContentCacheStatsForTests().size).toBe(0)
    } finally { await destroyHarness(host, root) }
  })

  test.each(['replacement', 'actions', 'reload', 'order'])('script %s changes invalidate cached output without relying on timestamps', async change => {
    isDisplayChatOwnedMock.mockImplementation(() => false)
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = [
      { ...originalScripts[0], id: 'first-script' },
      { ...originalScripts[0], id: 'second-script' },
    ]
    const { host, root } = await createHarness()
    try {
      await render(root, { content: 'chunk', isStreaming: false })
      await settle('chunk', 'previous cards')
      const [first, second] = storeState.regexScripts
      storeState.regexScripts = change === 'order' ? [second, first]
        : change === 'reload' ? storeState.regexScripts.map(script => ({ ...script }))
        : [{ ...first, ...(change === 'replacement'
          ? { replace_string: '<div>Updated card</div>' }
          : { metadata: { match_actions: ['repeat_back'] } }) }, second]
      await render(root, { content: 'chunk', isStreaming: false })
      await settle('chunk', 'updated cards')
      expect(readRendered(host)).toBe('updated cards')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(2)
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test.each(['', 'second state', undefined])('pairs cached body content with processing state %p', async nextState => {
    const { host, root } = await createHarness()
    try {
      const identity = { chatId: 'chat', messageId: 'message' }
      const first = { content: 'first raw', isStreaming: false, identity }
      holdPreprocess(first.content)
      await renderWhilePreprocessPending(root, first)
      await releasePreprocess(first.content, 'same body', 'first state')
      await waitForPending('same body')
      expect(applyDisplayRegexTiered.mock.calls.at(-1)?.[2]).toMatchObject({ processingState: 'first state' })
      await settle('same body', 'first output')
      const next = { content: 'next raw', isStreaming: false, identity }
      holdPreprocess(next.content)
      await renderWhilePreprocessPending(root, next)
      await releasePreprocess(next.content, 'same body', nextState)
      await waitForPending('same body')
      expect((applyDisplayRegexTiered.mock.calls.at(-1)?.[2] as { processingState?: string }).processingState).toBe(nextState)
      await settle('same body', 'next output')
      expect(readRendered(host)).toBe('next output')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(2)
      await act(async () => { root.render(null) })
      await act(async () => { root.render(createElement(Harness, next)) })
      expect(readRendered(host)).toBe('next output')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(2)
    } finally { await destroyHarness(host, root) }
  })

  test('a late final pass cannot commit for another processing state with identical text', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat', messageId: 'message' }
    try {
      holdPreprocess('first raw')
      await renderWhilePreprocessPending(root, { content: 'first raw', isStreaming: true, identity })
      await releasePreprocess('first raw', 'same body', 'first state')
      await waitForPending('same body')
      const stale = pendingResults.get('same body')!
      holdPreprocess('second raw')
      await renderWhilePreprocessPending(root, { content: 'second raw', isStreaming: true, identity })
      await releasePreprocess('second raw', 'same body', 'second state')
      await waitForPending('same body')
      await act(async () => { stale({ result: 'stale output', cacheable: true, touchedVars: new Set() }) })
      expect(readRendered(host)).not.toBe('stale output')
      await settle('same body', 'current output')
      expect(readRendered(host)).toBe('current output')
    } finally { await destroyHarness(host, root) }
  })

  test.each(['empty', 'disabled', 'depth-filtered'])('owned chats finish display processing with %s scripts', async variant => {
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = variant === 'empty' ? [] : originalScripts.map(script => ({
      ...script, disabled: variant === 'disabled', max_depth: variant === 'depth-filtered' ? 0 : null,
    }))
    const { host, root } = await createHarness()
    const props = { content: 'owned final stage', depth: 1, isStreaming: false }
    try {
      await render(root, props)
      expect(applyDisplayRegexTiered.mock.calls[0]?.[1]).toEqual([])
      expect(host.querySelector('output')?.dataset.pending).toBe('true')
      await settle(props.content, '<img src="/asset">')
      expect(readRendered(host)).toBe('<img src="/asset">')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      await act(async () => { root.render(null) })
      await act(async () => { root.render(createElement(Harness, props)) })
      expect(readRendered(host)).toBe('<img src="/asset">')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test.each([undefined, false])('legacy owning resolvers do not receive empty script calls (opt-in=%s)', async optIn => {
    finalizeWithoutScripts = optIn
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = []
    const { host, root } = await createHarness()
    try {
      await renderWhilePreprocessPending(root, { content: 'legacy text', isStreaming: false })
      expect(readRendered(host)).toBe('legacy text')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
    } finally {
      finalizeWithoutScripts = true
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('unowned chats with no scripts keep the preprocessing result', async () => {
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = []
    isDisplayChatOwnedMock.mockImplementation(() => false)
    const { host, root } = await createHarness()
    try {
      await renderWhilePreprocessPending(root, { content: 'native text', isStreaming: false })
      expect(readRendered(host)).toBe('native text')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('a cold virtual row stays provisional through preprocessing and HTML replacement', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-virtual', messageId: 'message-virtual' }
    const content = 'chunk virtual'
    holdPreprocess(content)
    try {
      await renderWhilePreprocessPending(root, { content, identity, isStreaming: false })
      expect(host.querySelector('output')?.dataset.pending).toBe('true')
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()

      await releasePreprocess(content)
      await waitForPending(content)
      expect(host.querySelector('output')?.dataset.pending).toBe('true')

      await settle(content, '<div style="height:800px">Replacement</div>')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(readRendered(host)).toBe('<div style="height:800px">Replacement</div>')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('a virtual remount commits cached HTML immediately without a provisional raw frame', async () => {
    const { host, root } = await createHarness()
    const props = {
      content: 'chunk remount',
      identity: { chatId: 'chat-remount', messageId: 'message-remount' },
      isStreaming: false,
    }
    const html = '<div style="height:800px">Cached replacement</div>'
    try {
      await render(root, props)
      await settle(props.content, html)
      await act(async () => { root.render(null) })

      const commits: Array<{ content: string; pending: boolean }> = []
      await act(async () => {
        root.render(createElement(Harness, { ...props, onCommit: (state) => commits.push(state) }))
      })
      expect(commits.length).toBeGreaterThan(0)
      expect(commits.every((state) => state.content === html && !state.pending)).toBe(true)
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('an idle cache invalidation keeps resolved HTML visible during refresh', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-refresh', messageId: 'message-refresh' }
    try {
      await render(root, { content: 'chunk refresh', identity, isStreaming: false })
      await settle('chunk refresh', '<div>Original replacement</div>')
      await act(async () => { invalidateDisplayRegexCache() })
      await waitForPending('chunk refresh')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(readRendered(host)).toBe('<div>Original replacement</div>')
      await settle('chunk refresh', '<div>Refreshed replacement</div>')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(readRendered(host)).toBe('<div>Refreshed replacement</div>')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('sending a message keeps existing HTML visible through depth-dependent preprocessing and regex work', async () => {
    const { host, root } = await createHarness()
    const props = {
      content: 'chunk source',
      identity: { chatId: 'chat-depth', messageId: 'message-depth' },
      isStreaming: false,
    }
    const html = '<div style="height:800px">Existing island</div>'
    try {
      holdPreprocess(props.content)
      await renderWhilePreprocessPending(root, props)
      await releasePreprocess(props.content, 'chunk preprocessed')
      await waitForPending('chunk preprocessed')
      await settle('chunk preprocessed', html)

      // Appending a message changes every existing row's depth, even though
      // its source and identity are unchanged. Observe every commit: an
      // immediate resolver would conceal the provisional blank frame.
      const commits: Array<{ content: string; pending: boolean }> = []
      holdPreprocess(props.content)
      await renderWhilePreprocessPending(root, {
        ...props, depth: 1, onCommit: (state) => commits.push(state),
      })
      expect(pendingPreprocess.has(props.content)).toBe(true)
      expect(commits.length).toBeGreaterThan(0)
      expect(commits.every((state) => state.content === html && !state.pending)).toBe(true)

      await releasePreprocess(props.content, 'chunk refreshed')
      await waitForPending('chunk refreshed')
      expect(commits.every((state) => state.content === html && !state.pending)).toBe(true)
      await settle('chunk refreshed', '<div>Updated island</div>')
      expect(readRendered(host)).toBe('<div>Updated island</div>')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('a backend preprocess refresh retains visible passthrough content until its depth update settles', async () => {
    const { host, root } = await createHarness()
    const props = {
      content: 'Plain message',
      identity: { chatId: 'chat-passthrough-depth', messageId: 'message-passthrough-depth' },
      isStreaming: false,
    }
    isDisplayChatOwnedMock.mockImplementation(() => false)
    try {
      await renderWhilePreprocessPending(root, props)
      await act(async () => { await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 12)) })
      expect(host.querySelector('output')?.dataset.pending).toBe('false')

      const commits: Array<{ content: string; pending: boolean }> = []
      heldRemotePreprocess.add(props.content)
      await renderWhilePreprocessPending(root, {
        ...props, depth: 1, onCommit: (state) => commits.push(state),
      })
      await act(async () => { await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 12)) })
      expect(pendingRemotePreprocess.has(props.content)).toBe(true)
      expect(commits.length).toBeGreaterThan(0)
      expect(commits.every((state) => state.content === props.content && !state.pending)).toBe(true)

      await act(async () => {
        pendingRemotePreprocess.get(props.content)!(remotePreprocessResponse(['Updated plain message']))
      })
      expect(readRendered(host)).toBe('Updated plain message')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('native saved messages wait for their body stage before applying regex', async () => {
    const { host, root } = await createHarness()
    const props = { content: 'chunk before preprocess', identity: { chatId: 'native-once-chat', messageId: 'native-once-message' }, isStreaming: false }
    isDisplayChatOwnedMock.mockImplementation(() => false)
    heldRemotePreprocess.add(props.content)
    try {
      await renderWhilePreprocessPending(root, props)
      for (let i = 0; i < 20 && !pendingRemotePreprocess.has(props.content); i++) await flushReact()
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
      await act(async () => {
        pendingRemotePreprocess.get(props.content)!(remotePreprocessResponse(['prefix chunk after preprocess']))
      })
      await waitForPending('prefix chunk after preprocess')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
      await settle('prefix chunk after preprocess', '<button>Verified choice</button>')
      expect(readRendered(host)).toBe('<button>Verified choice</button>')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('a regex that expires at the new depth replaces retained HTML once preprocessing settles', async () => {
    const { host, root } = await createHarness()
    const props = {
      content: 'chunk depth-limited',
      identity: { chatId: 'chat-depth-limit', messageId: 'message-depth-limit' },
      isStreaming: false,
    }
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = originalScripts.map((script) => ({ ...script, max_depth: 0 }))
    try {
      await render(root, props)
      await settle(props.content, '<div>Depth-limited island</div>')

      holdPreprocess(props.content)
      await renderWhilePreprocessPending(root, { ...props, depth: 1 })
      expect(readRendered(host)).toBe('<div>Depth-limited island</div>')
      expect(host.querySelector('output')?.dataset.pending).toBe('false')

      await releasePreprocess(props.content)
      await waitForPending(props.content)
      expect(readRendered(host)).toBe('<div>Depth-limited island</div>')
      expect(applyDisplayRegexTiered.mock.calls.at(-1)?.[1]).toEqual([])
      await settle(props.content, props.content)
      expect(readRendered(host)).toBe(props.content)
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(2)
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test.each(['chat', 'message', 'source', 'remount'] as const)(
    'a %s change cannot reuse the prior visible display during preprocessing',
    async (change) => {
      const { host, root } = await createHarness()
      const props = {
        content: 'chunk original',
        identity: { chatId: 'chat-retention', messageId: 'message-retention' },
        isStreaming: false,
      }
      try {
        await render(root, props)
        await settle(props.content, '<div>Original island</div>')
        if (change === 'remount') await act(async () => { root.render(null) })
        const next = {
          ...props,
          depth: 1,
          content: change === 'source' ? 'chunk edited' : props.content,
          identity: {
            chatId: change === 'chat' ? 'chat-next' : props.identity.chatId,
            messageId: change === 'message' ? 'message-next' : props.identity.messageId,
          },
        }
        holdPreprocess(next.content)
        await renderWhilePreprocessPending(root, next)
        expect(readRendered(host)).toBe(next.content)
        expect(host.querySelector('output')?.dataset.pending).toBe('true')
        await releasePreprocess(next.content)
        await waitForPending(next.content)
        await settle(next.content, '<div>Next island</div>')
        expect(readRendered(host)).toBe('<div>Next island</div>')
        expect(host.querySelector('output')?.dataset.pending).toBe('false')
      } finally {
        await destroyHarness(host, root)
      }
    },
  )

  test('a failed regex pass releases the reserved row with fallback text', async () => {
    const { host, root } = await createHarness()
    applyDisplayRegexTiered.mockImplementationOnce(() => Promise.reject(new Error('resolver unavailable')))
    try {
      await act(async () => {
        root.render(createElement(Harness, { content: 'chunk failure', isStreaming: false }))
      })
      await flushReact()
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
      expect(readRendered(host)).toBe('chunk failure')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('StrictMode effect replay still resolves the mounted message', async () => {
    const { host, root } = await createHarness()
    try {
      await act(async () => root.render(createElement(StrictMode, null,
        createElement(Harness, { content: 'chunk strict', isStreaming: true }),
      )))
      await waitForPending('chunk strict')
      await settle('chunk strict', 'resolved strict')
      expect(readRendered(host)).toBe('resolved strict')
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('an invalidation starts fresh work and a late pre-invalidation result cannot overwrite it', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-invalidated', messageId: 'message-invalidated' }
    try {
      await render(root, { content: 'chunk', identity, isStreaming: true })
      const obsolete = pendingResults.get('chunk')!
      await act(async () => invalidateDisplayRegexCache())
      await flushReact()
      expect(pendingResults.get('chunk')).not.toBe(obsolete)
      await settle('chunk', 'fresh result')
      await act(async () => obsolete({ result: 'obsolete', touchedVars: new Set(), cacheable: true }))
      expect(readRendered(host)).toBe('fresh result')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('slow preprocessing advances completed prefixes and replaces queued token revisions', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-slow-preprocess', messageId: 'message-slow-preprocess' }
    try {
      holdPreprocess('chunk')
      holdPreprocess('chunk one two')
      await renderWhilePreprocessPending(root, { content: 'chunk', identity, isStreaming: true })
      await renderWhilePreprocessPending(root, { content: 'chunk one', identity, isStreaming: true })
      await renderWhilePreprocessPending(root, { content: 'chunk one two', identity, isStreaming: true })
      expect([...pendingPreprocess.keys()]).toEqual(['chunk'])
      await releasePreprocess('chunk')
      await waitForPending('chunk')
      expect(pendingPreprocess.has('chunk one two')).toBe(true)
      await settle('chunk', 'resolved prefix')
      expect(readRendered(host)).toBe('resolved prefix')
      await releasePreprocess('chunk one two')
      await waitForPending('chunk one two')
      await settle('chunk one two', 'resolved latest')
      expect(readRendered(host)).toBe('resolved latest')
      expect(applyDisplayRegexTiered.mock.calls.map(([content]) => content)).toEqual(['chunk', 'chunk one two'])
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('paints safe plain-text suffixes immediately but holds a new macro opener', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-plain-stream', messageId: 'message-plain-stream' }
    const originalScripts = storeState.regexScripts
    isDisplayChatOwnedMock.mockImplementation(() => false)
    storeState.regexScripts = []

    try {
      await act(async () => {
        root.render(createElement(Harness, {
          content: 'Hello',
          identity,
          isStreaming: true,
        }))
      })
      await flushReact()
      await act(async () => {
        await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 12))
      })
      expect(readRendered(host)).toBe('Hello')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      heldRemotePreprocess.add('Hello world')
      await renderWhilePreprocessPending(root, {
        content: 'Hello world',
        identity,
        isStreaming: true,
      })
      expect(readRendered(host)).toBe('Hello world')

      heldRemotePreprocess.add('Hello world {')
      await renderWhilePreprocessPending(root, {
        content: 'Hello world {',
        identity,
        isStreaming: true,
      })
      expect(readRendered(host)).toBe('Hello world')
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('braille cleanup streams synchronously without regex jobs or repeated preprocessing', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-braille-stream', messageId: 'message-braille-stream' }
    const originalScripts = storeState.regexScripts
    isDisplayChatOwnedMock.mockImplementation(() => false)
    storeState.regexScripts = [
      ...originalScripts.map(script => ({
        ...script, find_regex: String.raw`[\u2800]`, replace_string: ' ',
      })),
      { ...originalScripts[0], id: 'unused-card', find_regex: String.raw`\[STATUS\](.*?)\[/STATUS\]`, replace_string: '<div>$1</div>' },
    ]
    try {
      let content = 'Hello⠀friend'
      await renderWhilePreprocessPending(root, { content, identity, isStreaming: true })
      await act(async () => { await new Promise<void>(resolve => domWindow.setTimeout(resolve, 12)) })
      for (const suffix of Array(40).fill('⠀word')) {
        content += suffix
        const commits: Array<{ content: string; pending: boolean }> = []
        await act(async () => root.render(createElement(Harness, {
          content, identity, isStreaming: true, onCommit: state => commits.push(state),
        })))
        expect(commits.length).toBeGreaterThan(0)
        expect(commits.every(state => state.content === content.replaceAll('⠀', ' '))).toBe(true)
      }
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes(identity.chatId))).toHaveLength(1)
      await renderWhilePreprocessPending(root, { content, identity, isStreaming: false })
      await act(async () => { await new Promise<void>(resolve => domWindow.setTimeout(resolve, 12)) })
      expect(readRendered(host)).toBe(content.replaceAll('⠀', ' '))
      expect(host.querySelector('output')?.dataset.pending).toBe('false')
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('display regexes resolve each answer frame without a trailing timer', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-worker-stream', messageId: 'message-worker-stream' }
    const originalScripts = storeState.regexScripts
    storeState.regexScripts = originalScripts.map((script) => ({ ...script, find_regex: 'Hello' }))
    isDisplayChatOwnedMock.mockImplementation(() => false)

    try {
      await render(root, { content: 'Hello', identity, isStreaming: true })
      await settle('Hello', '[Hello]')
      await act(async () => {
        await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 12))
      })
      expect(readRendered(host)).toBe('[Hello]')

      await act(async () => {
        root.render(createElement(Harness, {
          content: 'Hello world',
          identity,
          isStreaming: true,
        }))
      })
      await waitForPending('Hello world')
      expect(readRendered(host)).toBe('[Hello]')
      await settle('Hello world', '[Hello world]')
      expect(readRendered(host)).toBe('[Hello world]')

      // A possible macro opener holds the latest resolved answer frame.
      heldRemotePreprocess.add('Hello world {')
      await act(async () => {
        root.render(createElement(Harness, {
          content: 'Hello world {',
          identity,
          isStreaming: true,
        }))
      })
      await flushReact()
      expect(readRendered(host)).toBe('[Hello world]')
      expect(pendingResults.has('Hello world {')).toBe(false)
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  test('tracks only the first preprocess and regex keys of an active stream', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-recovery-stream', messageId: 'message-recovery-stream' }

    try {
      await render(root, { content: 'chunk recovery one', identity, isStreaming: true })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(2)
      await settle('chunk recovery one', 'resolved recovery one')

      await render(root, { content: 'chunk recovery one two', identity, isStreaming: true })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(2)
      await settle('chunk recovery one two', 'resolved recovery two')

      await render(root, { content: 'chunk recovery final', identity, isStreaming: false })
      expect(trackInitialDisplayResolve).toHaveBeenCalledTimes(4)
      await settle('chunk recovery final', 'resolved recovery final')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('slow passes advance streaming prefixes and drain only the newest queued revision', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-progress', messageId: 'message-progress' }
    try {
      await render(root, { content: 'chunk', identity, isStreaming: true })
      await settle('chunk', 'resolved')
      await render(root, { content: 'chunk one', identity, isStreaming: true })
      await renderWhilePreprocessPending(root, { content: 'chunk one two', identity, isStreaming: true })
      await renderWhilePreprocessPending(root, { content: 'chunk one two three', identity, isStreaming: true })
      expect([...pendingResults.keys()]).toEqual(['chunk one'])
      await settle('chunk one', 'resolved one')
      expect(readRendered(host)).toBe('resolved one')
      await waitForPending('chunk one two three')
      expect(pendingResults.has('chunk one two')).toBe(false)

      // Finalization queues behind the active pass and always drains.
      await renderWhilePreprocessPending(root, { content: 'chunk one two three final', identity, isStreaming: false })
      await settle('chunk one two three', 'resolved one two three')
      expect(readRendered(host)).toBe('resolved one two three')
      await waitForPending('chunk one two three final')
      await settle('chunk one two three final', 'resolved final')
      expect(readRendered(host)).toBe('resolved final')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('a rewrite rejects an active old result while still draining the latest input', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-rewrite', messageId: 'message-rewrite' }
    try {
      await render(root, { content: 'chunk seed', identity, isStreaming: true })
      await settle('chunk seed', 'resolved seed')
      await render(root, { content: 'chunk old', identity, isStreaming: true })
      await renderWhilePreprocessPending(root, { content: 'chunk rewritten', identity, isStreaming: true })
      await settle('chunk old', 'obsolete')
      expect(readRendered(host)).toBe('resolved seed')
      await waitForPending('chunk rewritten')
      await settle('chunk rewritten', 'resolved rewritten')
      expect(readRendered(host)).toBe('resolved rewritten')
    } finally {
      await destroyHarness(host, root)
    }
  })

  test('unmatched backend-capable scripts stream without regex jobs or repeated preprocessing', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-gate', messageId: 'message-gate' }
    const originalScripts = storeState.regexScripts
    isDisplayChatOwnedMock.mockImplementation(() => false)
    storeState.regexScripts = originalScripts.map((script) => ({
      ...script,
      find_regex: String.raw`\[STATUS\]([\s\S]*?)\[/STATUS\]`,
      substitute_macros: 'raw',
      replace_string: '{{getvar::$1}}',
    }))
    try {
      let content = 'Hello'
      await renderWhilePreprocessPending(root, { content, identity, isStreaming: true })
      await act(async () => { await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 12)) })
      for (const suffix of [...Array(40).fill(' word'), ...'[STATUS]value[/STATUS']) {
        content += suffix
        await act(async () => root.render(createElement(Harness, { content, identity, isStreaming: true })))
        expect(readRendered(host)).toBe(content)
      }
      expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      content += ']'
      await render(root, { content, identity, isStreaming: true })
      expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
      await settle(content, 'Hello rendered status')
      expect(readRendered(host)).toBe('Hello rendered status')
    } finally {
      storeState.regexScripts = originalScripts
      await destroyHarness(host, root)
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('generated chat, message, implicit-identity, and new-stream changes reset resolved carry', async () => {
    const resetCases: Array<{
      name: string
      initialIdentity: Identity
      nextIdentity?: Identity
      initialStreaming: boolean
      nextStreaming: boolean
    }> = [
      {
        name: 'message-change',
        initialIdentity: { chatId: 'chat-message-change', messageId: 'message-before' },
        nextIdentity: { chatId: 'chat-message-change', messageId: 'message-after' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'chat-change',
        initialIdentity: { chatId: 'chat-before', messageId: 'message-chat-change' },
        nextIdentity: { chatId: 'chat-after', messageId: 'message-chat-change' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'implicit-identity',
        initialIdentity: { chatId: 'chat-explicit', messageId: 'message-explicit' },
        nextIdentity: undefined,
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'new-stream',
        initialIdentity: { chatId: 'chat-new-stream', messageId: 'message-new-stream' },
        nextIdentity: { chatId: 'chat-new-stream', messageId: 'message-new-stream' },
        initialStreaming: false,
        nextStreaming: true,
      },
    ]

    for (const resetCase of resetCases) {
      const { host, root } = await createHarness()
      const initial = `chunk ${resetCase.name} initial`
      const next = `chunk ${resetCase.name} next`

      try {
        await render(root, {
          content: initial,
          identity: resetCase.initialIdentity,
          isStreaming: resetCase.initialStreaming,
        })
        await settle(initial, `resolved ${resetCase.name} initial`)
        expect(readRendered(host)).toBe(`resolved ${resetCase.name} initial`)

        await render(root, {
          content: next,
          identity: resetCase.nextIdentity,
          isStreaming: resetCase.nextStreaming,
        })
        expect(readRendered(host)).toBe(next)
        await settle(next, `resolved ${resetCase.name} next`)
        expect(readRendered(host)).toBe(`resolved ${resetCase.name} next`)
      } finally {
        await destroyHarness(host, root)
      }
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('a pending preprocess key keeps the last preprocessed value of the same identity and finalizes the authoritative key', async () => {
    const { host, root } = await createHarness()
    const identity = { chatId: 'chat-preprocess-carry', messageId: 'message-preprocess-carry' }
    const first = 'chunk carry one'
    const second = 'chunk carry one two'
    const authoritative = 'chunk carry one two final'

    try {
      await render(root, { content: first, identity, isStreaming: true })
      await settle(first, 'resolved carry one')
      expect(readRendered(host)).toBe('resolved carry one')

      // Mid-stream flush: the newest preprocess key is in flight, so the
      // unpreprocessed source must never reach the render.
      holdPreprocess(second)
      await renderWhilePreprocessPending(root, { content: second, identity, isStreaming: true })
      expect(readRendered(host)).toBe('resolved carry one')
      await releasePreprocess(second)
      await waitForPending(second)
      expect(readRendered(host)).toBe('resolved carry one')
      await settle(second, 'resolved carry two')
      expect(readRendered(host)).toBe('resolved carry two')

      // Finalization commits a DIFFERENT key than the last streamed chunk, and
      // resolves in two stages (preprocess, then regex). Neither stage may
      // expose unpreprocessed source.
      holdPreprocess(authoritative)
      await renderWhilePreprocessPending(root, { content: authoritative, identity, isStreaming: false })
      expect(readRendered(host)).toBe('resolved carry two')
      await releasePreprocess(authoritative)
      await waitForPending(authoritative)
      expect(readRendered(host)).toBe('resolved carry two')
      await settle(authoritative, 'resolved carry final')
      expect(readRendered(host)).toBe('resolved carry final')
    } finally {
      await destroyHarness(host, root)
    }
  })

  /** **Validates: Requirements 2.5, 2.7, 3.6, 3.8** */
  test('a pending preprocess key never carries a preprocessed value across chat, message, or stream identities', async () => {
    const leakCases: Array<{
      name: string
      initialIdentity: Identity
      nextIdentity: Identity
      initialStreaming: boolean
      nextStreaming: boolean
    }> = [
      {
        name: 'leak-message-change',
        initialIdentity: { chatId: 'chat-leak-message', messageId: 'message-leak-before' },
        nextIdentity: { chatId: 'chat-leak-message', messageId: 'message-leak-after' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'leak-chat-change',
        initialIdentity: { chatId: 'chat-leak-before', messageId: 'message-leak-chat' },
        nextIdentity: { chatId: 'chat-leak-after', messageId: 'message-leak-chat' },
        initialStreaming: true,
        nextStreaming: true,
      },
      {
        name: 'leak-new-stream',
        initialIdentity: { chatId: 'chat-leak-stream', messageId: 'message-leak-stream' },
        nextIdentity: { chatId: 'chat-leak-stream', messageId: 'message-leak-stream' },
        initialStreaming: false,
        nextStreaming: true,
      },
    ]

    for (const leakCase of leakCases) {
      const { host, root } = await createHarness()
      const initial = `chunk ${leakCase.name} initial`
      const next = `chunk ${leakCase.name} next`

      try {
        await render(root, {
          content: initial,
          identity: leakCase.initialIdentity,
          isStreaming: leakCase.initialStreaming,
        })
        await settle(initial, `resolved ${leakCase.name} initial`)
        expect(readRendered(host)).toBe(`resolved ${leakCase.name} initial`)

        holdPreprocess(next)
        await renderWhilePreprocessPending(root, {
          content: next,
          identity: leakCase.nextIdentity,
          isStreaming: leakCase.nextStreaming,
        })
        expect(readRendered(host)).toBe(next)
        expect(readRendered(host)).not.toBe(`resolved ${leakCase.name} initial`)

        await releasePreprocess(next)
        await waitForPending(next)
        await settle(next, `resolved ${leakCase.name} next`)
        expect(readRendered(host)).toBe(`resolved ${leakCase.name} next`)
      } finally {
        await destroyHarness(host, root)
      }
    }
  })
})
test('cold preset definitions keep raw content provisional', async () => {
  isDisplayChatOwnedMock.mockImplementation(() => false)
  let releaseScripts!: (value: Awaited<ReturnType<typeof getPresetScripts>>) => void
  getPresetScripts.mockImplementationOnce(() => new Promise(resolve => { releaseScripts = resolve }))
  const raw = 'chunk source not yet loaded'
  storeState.messages = [{ id: 'source-message', chat_id: 'source-chat', index_in_chat: 0, is_user: false, name: 'Assistant', content: raw,
    send_date: 0, swipe_id: 0, swipes: [raw], swipe_dates: [0], parent_message_id: null, branch_id: null, created_at: 0,
    extra: { spindle_metadata: { preset_contexts: [{ preset_id: 'source-preset' }] } } }]
  const { host, root } = await createHarness()
  try {
    await act(async () => { root.render(createElement(Harness, { content: raw, identity: { chatId: 'source-chat', messageId: 'source-message' }, isStreaming: false })) })
    for (let i = 0; i < 8; i++) await flushReact()
    expect(applyDisplayRegexTiered).not.toHaveBeenCalled()
    expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('true')
    await act(async () => { releaseScripts([{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset' }]) })
    await waitForPending(raw)
    expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('true')
    await settle(raw, 'Completed source rendering')
    expect(readRendered(host)).toBe('Completed source rendering')
    expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('false')
  } finally {
    await act(async () => { releaseScripts([{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset' }]) })
    await destroyHarness(host, root)
  }
})

function sourceMessage(presetId = 'source-preset'): Message {
  return { id: 'source-message', chat_id: 'source-chat', index_in_chat: 0, is_user: false, name: 'Assistant', content: 'chunk source',
    send_date: 0, swipe_id: 0, swipes: ['chunk source'], swipe_dates: [0], parent_message_id: null, branch_id: null, created_at: 0,
    extra: { spindle_metadata: { preset_contexts: [{ preset_id: presetId }] } } }
}

test('failed preset definition loads release the row and retry after remount', async () => {
  isDisplayChatOwnedMock.mockImplementation(() => false)
  getPresetScripts.mockImplementationOnce(async () => { throw new Error('Temporary outage') })
  storeState.messages = [sourceMessage()]
  let harness = await createHarness()
  const props = { content: 'chunk source', identity: { chatId: 'source-chat', messageId: 'source-message' }, isStreaming: false }
  try {
    await act(async () => { harness.root.render(createElement(Harness, props)) })
    for (let i = 0; i < 8; i++) await flushReact()
    expect(harness.host.querySelector('output')?.getAttribute('data-pending')).toBe('false')
    expect(readRendered(harness.host)).toBe('chunk source')
    expect(getPresetScripts).toHaveBeenCalledTimes(1)
    await act(async () => harness.root.unmount())
    harness.host.remove()
    harness = await createHarness()
    await render(harness.root, props)
    await settle(props.content, 'Recovered rendering')
    expect(readRendered(harness.host)).toBe('Recovered rendering')
    expect(getPresetScripts).toHaveBeenCalledTimes(2)
  } finally { await destroyHarness(harness.host, harness.root) }
})

test('a late preset fetch cannot replace the newly selected source', async () => {
  isDisplayChatOwnedMock.mockImplementation(() => false)
  let releaseScripts!: (value: Awaited<ReturnType<typeof getPresetScripts>>) => void
  getPresetScripts.mockImplementationOnce(() => new Promise(resolve => { releaseScripts = resolve }))
  getPresetScripts.mockImplementationOnce(async () => [{ ...storeState.regexScripts[0], id: 'second-rule', preset_id: 'second' }])
  storeState.messages = [sourceMessage('first')]
  const { host, root } = await createHarness()
  const props = { content: 'chunk source', identity: { chatId: 'source-chat', messageId: 'source-message' }, isStreaming: false }
  try {
    await act(async () => { root.render(createElement(Harness, props)) })
    storeState.messages = [sourceMessage('second')]
    await render(root, props)
    expect((applyDisplayRegexTiered.mock.calls.at(-1)?.[1] as RegexScript[]).map(script => script.id)).toEqual(['second-rule'])
    await settle(props.content, 'Second source')
    await act(async () => { releaseScripts([{ ...storeState.regexScripts[0], id: 'first-rule', preset_id: 'first' }]) })
    await flushReact()
    expect(readRendered(host)).toBe('Second source')
    expect(applyDisplayRegexTiered).toHaveBeenCalledTimes(1)
  } finally { await destroyHarness(host, root) }
})

test('unmarked messages never request preset definitions', async () => {
  const { host, root } = await createHarness()
  try {
    await render(root, { content: 'chunk vanilla', isStreaming: false })
    await settle('chunk vanilla', 'Vanilla output')
    expect(getPresetScripts).not.toHaveBeenCalled()
    expect(readRendered(host)).toBe('Vanilla output')
  } finally { await destroyHarness(host, root) }
})

test('long source histories bound template caches and resolve evicted messages again', async () => {
  getPresetScripts.mockImplementationOnce(async () => [{ ...storeState.regexScripts[0], id: 'source-only', preset_id: 'source-preset',
    replace_string: '{{getvar::template_marker}}', substitute_macros: 'escaped' }])
  const { host, root } = await createHarness()
  try {
    for (const index of [...Array.from({ length: 320 }, (_, i) => i), 0]) {
      const message = { ...sourceMessage(), id: `history-${index}` }
      storeState.messages = [message]
      await render(root, { content: message.content, identity: { chatId: 'source-chat', messageId: message.id }, isStreaming: false })
      const context = applyDisplayRegexTiered.mock.calls.at(-1)?.[2] as { resolvedReplacements: Map<string, string> }
      expect(context.resolvedReplacements.get('source-only')).toBe(message.id)
      await settle(message.content, message.id)
      expect(readRendered(host)).toBe(message.id)
      expect(getDisplayContentCacheStatsForTests().templateSize).toBeLessThanOrEqual(300)
    }
    expect(getPresetScripts).toHaveBeenCalledTimes(1)
  } finally { await destroyHarness(host, root) }
})
