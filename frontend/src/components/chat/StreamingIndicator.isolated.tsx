import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import type { AgentActivityGeneration } from '@/types/ws-events'
import type { ComponentType } from 'react'
import type { StreamingStatus, StreamingStatusInput } from './StreamingIndicator'

mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['chat', 'panels', 'modals', 'settings'],
  fallbackLanguagesFor: (lng: string) => [lng],
  loadLanguageBundles: async () => {},
}))

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
;(dom.window as unknown as { matchMedia: Window['matchMedia'] }).matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}) as unknown as MediaQueryList
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true


const i18n = createInstance()
let useStore!: typeof import('@/store').useStore
let generateApi!: typeof import('@/api/generate').generateApi
let originalGetActive!: typeof generateApi.getActive
let StreamingIndicator!: typeof import('./StreamingIndicator').default
let deriveStreamingStatus!: typeof import('./StreamingIndicator').deriveStreamingStatus
let consumeGenerationStopResult!: typeof import('@/lib/generation-recovery').consumeGenerationStopResult
let root: Root | null = null
let host: HTMLDivElement | null = null

const generationId = 'generation-a'
const chatId = 'chat-a'

function activity(overrides: Partial<AgentActivityGeneration> = {}): AgentActivityGeneration {
  return {
    generationId,
    invocationOrder: ['child-a'],
    invocations: {
      'child-a': {
        invocationId: 'child-a',
        actor: 'child_profile',
        phase: 'started',
        status: 'running',
        startedAt: Date.now(),
        toolName: 'agent_delegate',
        elapsedMs: 0,
      },
    },
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    isStreaming: true,
    activeGenerationId: generationId,
    streamingError: null,
    terminalStatus: null,
    streamingContent: '',
    streamingReasoning: '',
    ...overrides,
  }
}

function setStore(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    activeChatId: chatId,
    activeGenerationId: generationId,
    isStreaming: true,
    streamingError: null,
    lastGenerationTerminalStatus: null,
    streamingContent: '',
    streamingReasoning: '',
    streamingGenerationType: 'normal',
    lastGenerationProvider: null,
    lastGenerationConnectionLabel: null,
    lastGenerationModel: null,
    chatHeads: [{
      generationId,
      chatId,
      characterName: 'Assistant',
      avatarUrl: null,
      status: 'assembling',
      model: 'deepseek-v4-flash',
      provider: 'Deepseek',
      startedAt: Date.now() - 1_000,
    }],
    agentActivityByGeneration: {},
    generationRequests: {},
    ...overrides,
  } as never)
}

async function renderIndicator() {
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <StreamingIndicator />
      </I18nextProvider>,
    )
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    resources: { en: { chat } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  const store = await import('@/store')
  useStore = store.useStore
  const generate = await import('@/api/generate')
  generateApi = generate.generateApi
  originalGetActive = generateApi.getActive
  const indicator = await import('./StreamingIndicator')
  StreamingIndicator = indicator.default
  deriveStreamingStatus = indicator.deriveStreamingStatus
  ;({ consumeGenerationStopResult } = await import('@/lib/generation-recovery'))
})

beforeEach(() => {
  root?.unmount()
  host?.remove()
  dom.window.localStorage.clear()
  generateApi.getActive = originalGetActive
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

describe('StreamingIndicator', () => {
  test('derives normal and Agentic lifecycle states', () => {
    expect(deriveStreamingStatus(input({ activeGenerationId: null }))).toBe('sending')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'assembling' } }))).toBe('queued')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'waiting' } }))).toBe('waiting')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'reasoning' } }))).toBe('reasoning')
    expect(deriveStreamingStatus(input({ chatHead: { status: 'streaming' }, streamingContent: 'hello' }))).toBe('streaming')
    expect(deriveStreamingStatus(input({ agentActivity: activity() }))).toBe('continuation')
    expect(deriveStreamingStatus(input({ isStreaming: false, terminalStatus: 'completed' }))).toBe('completed')
    expect(deriveStreamingStatus(input({ isStreaming: false, streamingError: 'provider failed' }))).toBe('error')
    expect(deriveStreamingStatus(input({ isStreaming: false, terminalStatus: 'stopped' }))).toBe('stopped')
  })

  test('shows exact Agentic started-event identity in the elapsed-zero queued state', async () => {
    setStore({
      activeGenerationId: null,
      isStreaming: false,
      chatHeads: [],
      lastGenerationProvider: 'stale-provider',
      lastGenerationModel: 'stale-model',
    })
    const state = useStore.getState()
    state.startStreaming(generationId, undefined, 'normal')
    state.setGenerationProviderMetadata({
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    })
    state.addChatHead({
      generationId,
      chatId,
      characterName: 'Assistant',
      avatarUrl: null,
      status: 'assembling',
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
      startedAt: Date.now(),
    })

    expect(useStore.getState()).toMatchObject({
      lastGenerationProvider: 'Deepseek',
      lastGenerationModel: 'deepseek-v4-flash',
    })
    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('queued')
    expect(indicator?.textContent).toContain('Queued · preparing context')
    expect(indicator?.textContent).toContain('Provider Deepseek · model deepseek-v4-flash')
    expect(indicator?.textContent).toContain('elapsed 00:00')
  })

  test('reports an absent provider without inferring one from the model', async () => {
    setStore({
      lastGenerationProvider: null,
      lastGenerationModel: 'deepseek-v4-flash',
      chatHeads: [{
        generationId,
        chatId,
        characterName: 'Assistant',
        avatarUrl: null,
        status: 'assembling',
        model: 'deepseek-v4-flash',
        startedAt: Date.now(),
      }],
    })

    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.textContent).toContain('Provider not reported · model deepseek-v4-flash')
    expect(indicator?.textContent).not.toContain('Provider Deepseek')
  })

  test('persists provider identity across active-generation reconciliation and drops it when absent', async () => {
    setStore()
    const startedAt = Date.now() - 5_000
    generateApi.getActive = async () => [{
      generationId,
      chatId,
      status: 'assembling',
      generationType: 'normal',
      characterName: 'Assistant',
      model: 'deepseek-v4-flash',
      provider: 'Deepseek',
      startedAt,
      councilRetryPending: false,
    }]

    await useStore.getState().reconcileChatHeads()
    expect(useStore.getState().chatHeads[0]).toMatchObject({
      generationId,
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    })
    const persistedWithProvider = JSON.parse(
      localStorage.getItem('lumiverse:chatHeads') ?? '[]',
    ) as Array<Record<string, unknown>>
    expect(persistedWithProvider[0]?.provider).toBe('Deepseek')

    generateApi.getActive = async () => [{
      generationId,
      chatId,
      status: 'assembling',
      generationType: 'normal',
      characterName: 'Assistant',
      model: 'deepseek-v4-flash',
      startedAt,
      councilRetryPending: false,
    }]
    await useStore.getState().reconcileChatHeads()

    const reconciled = useStore.getState().chatHeads[0]
    expect(reconciled && 'provider' in reconciled).toBe(false)
    const persistedWithoutProvider = JSON.parse(
      localStorage.getItem('lumiverse:chatHeads') ?? '[]',
    ) as Array<Record<string, unknown>>
    expect(persistedWithoutProvider[0] && 'provider' in persistedWithoutProvider[0]).toBe(false)
  })
  test('clears a deferred-send error without projecting failure or tearing down the active lifecycle', async () => {
    setStore({
      streamingError: 'stale failure',
      lastGenerationTerminalStatus: 'error',
      lastGenerationProvider: 'Deepseek',
      lastGenerationModel: 'deepseek-v4-flash',
      streamingContent: 'partial',
      streamingReasoning: 'reasoning',
    })

    useStore.getState().setStreamingError(null)

    const cleared = useStore.getState()
    expect(cleared.streamingError).toBeNull()
    expect(cleared.lastGenerationTerminalStatus).toBeNull()
    expect(cleared.isStreaming).toBe(true)
    expect(cleared.activeGenerationId).toBe(generationId)
    expect(cleared.lastGenerationProvider).toBe('Deepseek')
    expect(cleared.lastGenerationModel).toBe('deepseek-v4-flash')
    expect(cleared.streamingContent).toBe('partial')
    expect(cleared.streamingReasoning).toBe('reasoning')

    await renderIndicator()
    const activeIndicator = host?.querySelector('[role="status"]')
    expect(activeIndicator?.getAttribute('data-generation-status')).not.toBe('error')
    expect(activeIndicator?.textContent).not.toContain('Generation failed')

    useStore.getState().setStreamingError('Provider timed out')
    const failed = useStore.getState()
    expect(failed.streamingError).toBe('Provider timed out')
    expect(failed.lastGenerationTerminalStatus).toBe('error')
    expect(failed.isStreaming).toBe(false)
    expect(failed.activeGenerationId).toBeNull()
  })

  test('shows recovered provider identity when in-progress arrives without a started chat head', async () => {
    setStore({
      chatHeads: [],
      activeGenerationId: null,
      isStreaming: false,
      lastGenerationProvider: null,
      lastGenerationModel: null,
    })
    useStore.getState().startStreaming('generation-recovered')
    useStore.getState().setGenerationProviderMetadata({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    useStore.getState().reconcileStreamContent('partial', 0)

    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('streaming')
    expect(indicator?.textContent).toContain('Provider deepseek · model deepseek-v4-flash')
  })

  test('shows Council waiting operation and provider metadata', async () => {
    setStore({
      chatHeads: [{
        generationId,
        chatId,
        characterName: 'Assistant',
        avatarUrl: null,
        status: 'waiting',
        model: 'deepseek-v4-flash',
        provider: 'Deepseek',
        connectionLabel: 'council-connection',
        agentOperation: 'council',
        agentLifecycle: 'waiting',
        startedAt: Date.now() - 31_000,
      }],
    })
    const state = useStore.getState()
    expect(state.activeChatId).toBe(chatId)
    expect(state.activeGenerationId).toBe(generationId)
    expect(state.chatHeads).toHaveLength(1)
    const head = state.chatHeads[0]
    expect(head?.chatId).toBe(chatId)
    expect(head?.generationId).toBe(generationId)
    expect(head?.status).toBe('waiting')
    expect(head?.agentOperation).toBe('council')
    expect(head?.agentLifecycle).toBe('waiting')
    expect(head?.startedAt).toBeLessThan(Date.now() - 30_000)
    await renderIndicator()
    const indicator = host?.querySelector('[role="status"]')
    expect(indicator?.getAttribute('data-generation-status')).toBe('waiting')
    expect(indicator?.textContent).toContain('Provider Deepseek · model deepseek-v4-flash')
    expect(indicator?.textContent).toContain('council-connection')
    expect(indicator?.textContent).toContain('Council consultation · Waiting')
    expect(indicator?.textContent).toContain('elapsed 00:31')
    expect(indicator?.textContent).toContain('Still waiting after 30 seconds')
  })

  test('renders repaired failures as failed and accepted cancellation as stopped', async () => {
    setStore({ chatHeads: [] })
    let state = useStore.getState()
    state.beginGenerationRequest(chatId, {
      generationType: 'normal',
      requestAuthorityId: 'authority-failed',
    })
    state.acceptGenerationRequest(chatId, generationId, 'authority-failed', 'working')
    state.stopGenerationRequest(chatId)
    consumeGenerationStopResult(chatId, {
      stopped: false,
      status: 'terminal',
      terminal: {
        version: 2,
        status: 'terminal',
        turnId: generationId,
        generationId,
        revision: 3,
        target: { chatId, generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'terminal',
        workOutcome: 'failed',
        reason: 'provider_failure',
        recoveryEligible: true,
        recoveryAction: 'retry',
        omissionCount: 0,
        inspectionAttemptId: generationId,
      },
    }, generationId, 'Provider failed', 'authority-failed')

    await renderIndicator()
    let indicator = host?.querySelector('[role="status"]')
    expect(useStore.getState().generationRequests[chatId]?.status).toBe('error')
    expect(indicator?.getAttribute('data-generation-status')).toBe('error')
    expect(indicator?.textContent).toContain('Generation failed')
    expect(indicator?.textContent).not.toContain('Generation stopped')

    setStore({ chatHeads: [] })
    state = useStore.getState()
    state.beginGenerationRequest(chatId, {
      generationType: 'normal',
      requestAuthorityId: 'authority-accepted',
    })
    state.acceptGenerationRequest(chatId, generationId, 'authority-accepted', 'working')
    consumeGenerationStopResult(
      chatId,
      { stopped: true, status: 'accepted' },
      generationId,
      'Generation failed',
      'authority-accepted',
    )

    await renderIndicator()
    indicator = host?.querySelector('[role="status"]')
    expect(useStore.getState().generationRequests[chatId]?.status).toBe('stopped')
    expect(indicator?.getAttribute('data-generation-status')).toBe('stopped')
    expect(indicator?.textContent).toContain('Generation stopped')
    expect(indicator?.textContent).not.toContain('Generation failed')
  })
})
