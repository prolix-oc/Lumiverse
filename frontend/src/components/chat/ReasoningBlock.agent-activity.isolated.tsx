import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import chat from '../../i18n/locales/en/chat.json'
import frenchChat from '../../i18n/locales/fr/chat.json'
import italianChat from '../../i18n/locales/it/chat.json'
import japaneseChat from '../../i18n/locales/ja/chat.json'
import simplifiedChineseChat from '../../i18n/locales/zh/chat.json'
import traditionalChineseChat from '../../i18n/locales/zh-TW/chat.json'
import type { ReasoningBlockProps } from './ReasoningBlock'

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const englishI18n = createInstance()
const frenchI18n = createInstance()
let createRoot: typeof CreateRoot
let ReasoningBlock: typeof import('./ReasoningBlock').default
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { chat } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  await frenchI18n.use(initReactI18next).init({
    resources: { fr: { chat: frenchChat } },
    lng: 'fr',
    fallbackLng: 'fr',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  // ReactDOM must evaluate after JSDOM installs the browser globals it captures.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: ReasoningBlock } = await import('./ReasoningBlock'))
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function renderReasoningBlock(
  props: ReasoningBlockProps,
  i18nInstance = englishI18n,
): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18nInstance}>
        <ReasoningBlock {...props} />
      </I18nextProvider>,
    )
    await Promise.resolve()
  })
  return host
}

describe('ReasoningBlock agent activity', () => {
  test('renders nested live child/tool rows with localized status and aggregate usage', async () => {
    const container = await renderReasoningBlock({
      reasoning: '',
      isStreaming: true,
      agentActivity: {
        invocationOrder: ['child-1', 'tool-1'],
        invocations: {
          'child-1': {
            invocationId: 'child-1',
            actor: 'child_profile',
            profileName: 'Researcher',
            phase: 'started',
            status: 'running',
            startedAt: 1_000,
            elapsedMs: 2_000,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          'tool-1': {
            invocationId: 'tool-1',
            parentInvocationId: 'child-1',
            actor: 'child_profile',
            profileName: 'Researcher',
            phase: 'tool_call',
            status: 'succeeded',
            toolName: 'lore_search_entries',
            startedAt: 1_500,
            elapsedMs: 500,
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          },
        },
      },
    })

    const toggle = container.querySelector<HTMLButtonElement>('[data-reasoning-toggle="true"]')
    expect(toggle?.textContent).toContain('Agent activity · 1 active')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Researcher')
    expect(container.textContent).toContain('Search lore')
    expect(container.textContent).toContain('Completed')
    expect(container.textContent).toContain('20 tokens · 12 in / 8 out')
    expect(container.querySelector('ul ul [data-status="succeeded"]')).not.toBeNull()
  })

  test('localizes the main actor and reports terminal activity as non-active', async () => {
    const container = await renderReasoningBlock({
      reasoning: '',
      isStreaming: false,
      agentActivity: {
        invocationOrder: ['main-tool'],
        invocations: {
          'main-tool': {
            invocationId: 'main-tool',
            actor: 'main_model',
            phase: 'completed',
            status: 'succeeded',
            toolName: 'chat_search_history',
            startedAt: 1_000,
            elapsedMs: 500,
          },
        },
      },
    }, frenchI18n)

    const toggle = container.querySelector<HTMLButtonElement>('[data-reasoning-toggle="true"]')
    expect(toggle?.textContent).toContain('Activité des agents · aucune exécution en cours')
    await act(async () => toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Modèle principal')
    expect(container.textContent).not.toContain('Main model')
  })

  test('provides localized main actor and idle labels in every non-English locale', () => {
    for (const locale of [
      frenchChat,
      italianChat,
      japaneseChat,
      simplifiedChineseChat,
      traditionalChineseChat,
    ]) {
      expect(locale.agentActivity.actors.mainModel).not.toBe('Main model')
      expect(locale.agentActivity.idleLabel).toBeTruthy()
    }
  })

  test('renders retained summaries as status and counts without usage or error details', async () => {
    const container = await renderReasoningBlock({
      reasoning: '',
      isStreaming: false,
      agentSummary: {
        status: 'failed',
        invocationCount: 2,
        succeededCount: 1,
        failedCount: 1,
        cancelledCount: 0,
        timedOutCount: 0,
        toolCallCount: 3,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        errorCodes: ['provider_private_error'],
      },
    })

    expect(container.textContent).toContain('Agent activity · Failed · 2 runs')
    expect(container.textContent).toContain('1 completed')
    expect(container.textContent).toContain('1 failed')
    expect(container.textContent).toContain('3 tool calls')
    expect(container.textContent).not.toContain('120')
    expect(container.textContent).not.toContain('provider_private_error')
  })

  test('counts a completed root summary as one run', async () => {
    const container = await renderReasoningBlock({
      reasoning: '',
      isStreaming: false,
      agentSummary: {
        status: 'succeeded',
        invocationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        timedOutCount: 0,
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    })

    expect(container.textContent).toContain('Agent activity · Completed · 1 runs')
    expect(container.textContent).toContain('1 completed')
    expect(container.textContent).not.toContain('0 runs')
  })
})
