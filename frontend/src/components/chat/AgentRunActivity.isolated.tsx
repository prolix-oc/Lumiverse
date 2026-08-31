import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { ReactElement } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import type { AppStore } from '@/types/store'
import type { AgentRunPublicErrorV2, AgentRunPublicV2 } from '@/types/agent-runs'
import type { StoreApi } from 'zustand'

const workspaceRequests: string[] = []
const workspaceSectionRequests: Array<{ turnId: string; section: string; revision?: number }> = []
let invalidWorkspaceIndexResponse = false
let failWorkspaceSection = false
let deferWorkspaceSection = false
const pendingWorkspaceSections: Array<() => void> = []

mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))

mock.module('@/api/agent-runs', () => ({
  agentRunsApi: {
    changes: async () => { throw new Error('unused_changes') },
    status: async () => { throw new Error('unused_status') },
    workspace: async (turnId: string) => {
      workspaceRequests.push(turnId)
      if (invalidWorkspaceIndexResponse) {
        invalidWorkspaceIndexResponse = false
        return { version: 2, turnId, workspaceRevision: 7, sections: 'invalid', omitted: 0 }
      }
      return {
        version: 2,
        turnId,
        workspaceRevision: 7,
        omitted: 0,
        sections: [
          { section: 'tasks', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
          { section: 'records', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
          { section: 'artifacts', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
        ],
      }
    },
    workspaceSection: async (
      turnId: string,
      section: string,
      _page?: string | null,
      revision?: number,
    ) => {
      workspaceSectionRequests.push({ turnId, section, revision })
      if (failWorkspaceSection) {
        failWorkspaceSection = false
        throw new Error('workspace_section_failed')
      }
      const payload = {
        version: 2,
        turnId,
        section,
        workspaceRevision: revision ?? 7,
        entries: [],
        nextPage: null,
        omitted: 0,
      }
      if (deferWorkspaceSection) {
        return await new Promise<typeof payload>((resolve) => {
          pendingWorkspaceSections.push(() => resolve(payload))
        })
      }
      return payload
    },
    stop: async (turnId: string) => ({ status: 'terminal' as const, turnId, revision: 1 }),
  },
}))

mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['common', 'auth', 'landing', 'chat', 'shared', 'commands', 'modals', 'panels', 'settings', 'weaver', 'errors'],
  fallbackLanguagesFor: (language: string) => language === 'zh-TW' ? ['zh-TW', 'zh', 'en'] : language === 'en' ? ['en'] : [language, 'en'],
  loadLanguageBundles: async () => {},
}))

type TestUseStore = {
  <T>(selector: (state: AppStore) => T): T
  (): AppStore
  getState: StoreApi<AppStore>['getState']
  setState: StoreApi<AppStore>['setState']
}
type ActivityStripComponent = (props: { chatId: string; messageId: string; swipeId: number }) => ReactElement | null
type LiveRegionComponent = (props: { chatId: string }) => ReactElement | null

let useStore!: TestUseStore
let AgentRunActivityStrip!: ActivityStripComponent
let AgentRunLiveRegion!: LiveRegionComponent

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
;(dom.window as unknown as { matchMedia: Window['matchMedia'] }).matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}) as unknown as MediaQueryList
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  navigator: dom.window.navigator,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const i18n = createInstance()
let createRoot: typeof CreateRoot
let root: Root | null = null
let host: HTMLDivElement | null = null

function terminalRun(): AgentRunPublicV2 {
  return {
    version: 2,
    runId: 'run-public',
    turnId: 'turn-public',
    generationId: 'generation-public',
    chatId: 'chat-public',
    generationType: 'normal',
    target: { messageId: 'message-public', swipeId: 1 },
    workPhase: 'TERMINAL',
    workStatus: 'terminal',
    workOutcome: 'completed',
    recoveryEligible: false,
    recoveryAction: 'none',
    omissionCount: 0,
    inspectionAttemptId: 'attempt-public',
    reason: null,
    attemptLineage: {
      version: 1,
      attemptId: 'attempt-public',
      previousAttemptId: null,
      target: {
        chatId: 'chat-public',
        generationType: 'normal',
        messageId: 'message-public',
        swipeId: 1,
      },
      createdAt: 1_700_000_000,
    },
    revision: 4,
    sequence: 9,
    startedAt: 1_700_000_000,
    updatedAt: 1_700_000_004,
    activity: [{
      version: 2,
      id: 'root-public',
      parentId: null,
      kind: 'root',
      actor: 'root',
      phase: 'TERMINAL',
      status: 'completed',
      startedAt: 1_700_000_000,
      elapsedMs: 4_000,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, toolCalls: 1, childInvocations: 1 },
    }, {
      version: 2,
      id: 'tool-public',
      parentId: 'root-public',
      kind: 'tool',
      actor: 'tool',
      phase: 'WORK',
      status: 'completed',
      startedAt: 1_700_000_002,
      elapsedMs: 500,
      toolId: 'lore_search_entries',
    }],
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, toolCalls: 1, childInvocations: 1 },
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    terminalHandoff: {
      version: 2,
      committed: true,
      messageId: 'message-public',
      swipeId: 1,
      messageRevision: 3,
      swipeRevision: 2,
    },
  }
}

function publicError(overrides: Partial<AgentRunPublicErrorV2> = {}): AgentRunPublicErrorV2 {
  return {
    code: 'provider_request_error',
    category: 'provider',
    summaryCode: 'provider_request_error',
    recoveryEligible: false,
    recoveryAction: 'none',
    target: {
      chatId: 'chat-public',
      generationType: 'normal',
      messageId: 'message-public',
      swipeId: 1,
    },
    workPhase: 'TERMINAL',
    workStatus: 'terminal',
    workOutcome: 'failed',
    reason: 'provider_failure',
    omissionCount: 0,
    inspectionAttemptId: 'attempt-public',
    ...overrides,
  }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    resources: { en: { chat } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  const storeModule = await import('@/store')
  useStore = storeModule.useStore
  const activityModule = await import('./AgentRunActivity')
  AgentRunActivityStrip = activityModule.AgentRunActivityStrip
  AgentRunLiveRegion = activityModule.AgentRunLiveRegion
  // ReactDOM captures browser globals at module evaluation, so load it only after JSDOM is installed.
  ;({ createRoot } = await import('react-dom/client'))
  // Restore module mocks after the component captures them for this isolated test.
  mock.restore()
})

beforeEach(() => {
  workspaceRequests.length = 0
  workspaceSectionRequests.length = 0
  invalidWorkspaceIndexResponse = false
  failWorkspaceSection = false
  deferWorkspaceSection = false
  pendingWorkspaceSections.length = 0
  const run = terminalRun()
  useStore.setState({
    activeChatId: 'chat-public',
    agentRunProvisionalByKey: {},
    isStreaming: false,
    activeGenerationId: null,
    regeneratingMessageId: null,
    streamingSwipeId: null,
    agentRunTerminalByTarget: { 'chat-public:message-public:1': run },
    agentRunSyncByChat: { 'chat-public': 'ready' },
    agentRunOmittedEventsByChat: { 'chat-public': 0 },
    agentWorkspaceByTurn: {
      'turn-public': {
        chatId: 'chat-public',
        turnId: 'turn-public',
        status: 'ready',
        error: false,
        index: {
          version: 2,
          turnId: 'turn-public',
          workspaceRevision: 7,
          omitted: 0,
          sections: [
            { section: 'tasks', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
            { section: 'records', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
            { section: 'artifacts', count: 1, revision: 7, retention: 'chat_lifetime', visibility: 'owner' },
          ],
        },
        sections: {
          tasks: {
            loadingMore: false,
            preview: {
              version: 2,
              turnId: 'turn-public',
              section: 'tasks',
              workspaceRevision: 7,
              nextPage: null,
              omitted: 0,
              entries: [{
                kind: 'task', id: 'task-public', revision: 1, retention: 'chat_lifetime', visibility: 'owner',
                title: 'Check continuity', state: 'completed', required: true, assigned: true, dependencyCount: 1,
              }],
            },
          },
          records: {
            loadingMore: false,
            preview: {
              version: 2,
              turnId: 'turn-public',
              section: 'records',
              workspaceRevision: 7,
              nextPage: null,
              omitted: 0,
              entries: [{
                kind: 'decision', id: 'decision-public', revision: 1, retention: 'chat_lifetime', visibility: 'owner',
                title: 'Keep the established timeline', state: 'accepted',
              }],
            },
          },
          artifacts: {
            loadingMore: false,
            preview: {
              version: 2,
              turnId: 'turn-public',
              section: 'artifacts',
              workspaceRevision: 7,
              nextPage: null,
              omitted: 0,
              entries: [{
                kind: 'artifact', id: 'artifact-public', revision: 1, retention: 'chat_lifetime', visibility: 'public',
                name: 'timeline.txt', mimeType: 'text/plain', byteCount: 128, digestPrefix: 'abc123', published: true,
              }],
            },
          },
        },
      },
    },
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  document.body.replaceChildren()
  root = null
  host = null
})

async function renderActivity() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <AgentRunLiveRegion chatId="chat-public" />
        <AgentRunActivityStrip chatId="chat-public" messageId="message-public" swipeId={1} />
      </I18nextProvider>,
    )
    await Promise.resolve()
  })
}
function findAgentRunTab(kind: 'activity' | 'workspace'): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls$="-${kind}-panel"]`)
}


describe('AgentRunActivity', () => {
  test('opens a message/swipe-scoped dialog, traps keyboard navigation, and returns focus', async () => {
    await renderActivity()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    trigger.focus()
    await act(async () => trigger.click())

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close agent activity')
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      const panel = panelId ? document.getElementById(panelId) : null
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    const activityTabButton = findAgentRunTab('activity')!
    const activityPanel = document.getElementById(activityTabButton.getAttribute('aria-controls')!)
    expect(activityPanel?.firstElementChild?.lastElementChild?.textContent).toBe('4 sec')

    const activityTab = activityTabButton
    activityTab.focus()
    await act(async () => activityTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(findAgentRunTab('workspace')?.getAttribute('aria-selected')).toBe('true')

    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('renders status-only activity and separately fetched workspace previews without private payloads', async () => {
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    expect(document.body.textContent).toContain('Search lore')
    expect(document.body.textContent).toContain('25')

    await act(async () => findAgentRunTab('workspace')?.click())
    const taskToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Tasks'))!
    await act(async () => taskToggle.click())
    expect(document.body.textContent).toContain('Check continuity')
    expect(document.body.textContent).toContain('Required')

    const recordsToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Findings'))!
    await act(async () => recordsToggle.click())
    expect(document.body.textContent).toContain('Keep the established timeline')

    const artifactsToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Published artifacts'))!
    await act(async () => artifactsToggle.click())
    expect(document.body.innerHTML).not.toContain('abc123')
    expect(document.body.textContent).toContain('Child agents: 1')
    expect(document.body.textContent).toContain('Tool calls: 1')
    expect(document.body.textContent).toContain('timeline.txt')
    expect(document.body.textContent).toContain('text/plain')
    expect(document.body.innerHTML).not.toContain('reasoning')
    expect(document.body.innerHTML).not.toContain('arguments')
    expect(document.body.innerHTML).not.toContain('credentials')
    expect(document.body.innerHTML).not.toContain('privateBody')

  })

  test('renders only safe localized public error labels and hides malformed details', async () => {
    const run = terminalRun()
    useStore.setState({
      agentRunTerminalByTarget: {
        'chat-public:message-public:1': {
          ...run,
          error: publicError(),
        },
      },
    })
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    const alerts = document.querySelectorAll<HTMLElement>('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toBe('Model request failed.')
    expect(document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Model request failed.')
    expect(document.body.textContent).not.toContain('provider_private')
    expect(document.body.textContent).not.toContain('secret prompt')

    await act(async () => {
      useStore.setState({
        agentRunTerminalByTarget: {
          'chat-public:message-public:1': {
            ...run,
            error: publicError({
              code: 'invalid_input',
              summaryCode: 'invalid_input',
            }),
          },
        },
      })
      await Promise.resolve()
    })
    expect(document.querySelector<HTMLElement>('[role="alert"]')?.textContent).toBe('The input was invalid.')

    await act(async () => {
      useStore.setState({
        agentRunTerminalByTarget: {
          'chat-public:message-public:1': {
            ...run,
            error: publicError({
              code: 'future_private_prompt',
              summaryCode: 'future_private_prompt',
            }),
          },
        },
      })
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('The run ended with a safe server error.')
    expect(document.body.textContent).not.toContain('future_private_prompt')
    expect(document.querySelectorAll<HTMLElement>('[role="alert"]')).toHaveLength(1)
    expect(document.querySelector<HTMLElement>('[role="alert"]')?.textContent).toBe('The run ended with a safe server error.')

    const malformedErrorRun = JSON.parse(JSON.stringify({ ...run, error: 42 }))
    await act(async () => {
      useStore.setState({
        agentRunTerminalByTarget: {
          'chat-public:message-public:1': malformedErrorRun,
        },
      })
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('The run ended with a safe server error.')
    expect(document.querySelectorAll<HTMLElement>('[role="alert"]')).toHaveLength(1)
    expect(document.querySelector<HTMLElement>('[role="alert"]')?.textContent).toBe('The run ended with a safe server error.')
  })
  test('promotes a disconnected two-node cycle to a visible activity root', async () => {
    const run = terminalRun()
    run.activity = [
      { ...run.activity[0], id: 'cycle-a', parentId: 'cycle-b' },
      { ...run.activity[1], id: 'cycle-b', parentId: 'cycle-a' },
    ]
    useStore.setState({
      agentRunTerminalByTarget: {
        'chat-public:message-public:1': run,
      },
    })
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())

    const tree = document.querySelector<HTMLElement>('[aria-label="Agent and tool chronology"]')
    expect(tree).not.toBeNull()
    expect(tree?.querySelectorAll('li')).toHaveLength(2)
    expect(tree?.textContent).toContain('Root agent')
    expect(tree?.textContent).toContain('Search lore')
  })

  test('keeps a self-parented activity node visible once', async () => {
    const run = terminalRun()
    run.activity = [{ ...run.activity[0], id: 'self-cycle', parentId: 'self-cycle' }]
    useStore.setState({
      agentRunTerminalByTarget: {
        'chat-public:message-public:1': run,
      },
    })
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())

    const tree = document.querySelector<HTMLElement>('[aria-label="Agent and tool chronology"]')
    expect(tree).not.toBeNull()
    expect(tree?.querySelectorAll('li')).toHaveLength(1)
    expect(tree?.textContent).toContain('Root agent')
  })

  test('promotes a deeper disconnected cycle without duplicating its nodes', async () => {
    const run = terminalRun()
    run.activity = [
      { ...run.activity[0], id: 'cycle-a', parentId: 'cycle-b' },
      { ...run.activity[1], id: 'cycle-b', parentId: 'cycle-c' },
      { ...run.activity[0], id: 'cycle-c', parentId: 'cycle-a', kind: 'provider', actor: 'provider' },
    ]
    useStore.setState({
      agentRunTerminalByTarget: {
        'chat-public:message-public:1': run,
      },
    })
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())

    const tree = document.querySelector<HTMLElement>('[aria-label="Agent and tool chronology"]')
    expect(tree).not.toBeNull()
    expect(tree?.querySelectorAll('li')).toHaveLength(3)
    expect(tree?.textContent).toContain('Root agent')
    expect(tree?.textContent).toContain('Search lore')
    expect(tree?.textContent).toContain('Model round')
  })

  test('mounts one atomic polite run live region and no elapsed-time announcement', async () => {
    await renderActivity()
    const regions = document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')
    expect(regions).toHaveLength(1)
    expect(regions[0].textContent).toContain('Completed')
    expect(regions[0].textContent).not.toMatch(/\d+s|\d+m/)
  })

  test('reannounces the same phase when the chat and run identity change', async () => {
    const chatARun = {
      ...terminalRun(),
      runId: 'run-a',
      turnId: 'turn-a',
      chatId: 'chat-a',
      target: { messageId: 'message-a', swipeId: 1 },
    }
    const chatBRun = {
      ...terminalRun(),
      runId: 'run-b',
      turnId: 'turn-b',
      chatId: 'chat-b',
      target: { messageId: 'message-b', swipeId: 1 },
    }
    useStore.setState({
      agentRunTerminalByTarget: {
        'chat-a:message-a:1': chatARun,
        'chat-b:message-b:1': chatBRun,
      },
      agentRunSyncByChat: { 'chat-a': 'ready', 'chat-b': 'ready' },
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <AgentRunLiveRegion chatId="chat-a" />
        </I18nextProvider>,
      )
    })
    const firstAnnouncement = host.querySelector('[aria-live="polite"] > span')
    expect(firstAnnouncement?.textContent).toBe('Agent run Completed.')

    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <AgentRunLiveRegion chatId="chat-b" />
        </I18nextProvider>,
      )
    })
    const secondAnnouncement = host.querySelector('[aria-live="polite"] > span')
    expect(secondAnnouncement?.textContent).toBe('Agent run Completed.')
    expect(secondAnnouncement).not.toBe(firstAnnouncement)
  })

  test('hides a retained terminal summary during optimistic streaming until the exact run binds', async () => {
    useStore.setState({
      isStreaming: true,
      activeChatId: 'chat-public',
      activeGenerationId: null,
      regeneratingMessageId: 'message-public',
      streamingSwipeId: 1,
    })
    await renderActivity()
    expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull()

    const exactRun = terminalRun()
    exactRun.runId = 'run-current'
    exactRun.turnId = 'turn-current'
    exactRun.generationId = 'generation-current'
    exactRun.workPhase = 'WORK'
    exactRun.workStatus = 'running'
    exactRun.workOutcome = null
    exactRun.activity = exactRun.activity.map((node) => node.id === 'root-public'
      ? { ...node, phase: 'WORK', status: 'running', elapsedMs: 1_000 }
      : node)
    delete exactRun.terminalHandoff
    await act(async () => {
      useStore.setState({
        activeGenerationId: 'generation-current',
        agentRunProvisionalByKey: { 'chat-public\u0000generation-current\u0000run-current': exactRun },
      })
      await Promise.resolve()
    })
    expect(document.querySelector('[aria-haspopup="dialog"]')).not.toBeNull()
  })

  test('keeps retained terminal activity visible while a different message streams', async () => {
    useStore.setState({
      isStreaming: true,
      activeChatId: 'chat-public',
      activeGenerationId: 'generation-current',
      regeneratingMessageId: 'message-other',
      streamingSwipeId: 1,
    })

    await renderActivity()

    expect(document.querySelector('[data-attempt-id="attempt-public"]')).not.toBeNull()
  })

  test('keeps retained terminal activity visible while a sibling swipe streams', async () => {
    useStore.setState({
      isStreaming: true,
      activeChatId: 'chat-public',
      activeGenerationId: 'generation-current',
      regeneratingMessageId: 'message-public',
      streamingSwipeId: 2,
    })

    await renderActivity()

    expect(document.querySelector('[data-attempt-id="attempt-public"]')).not.toBeNull()
  })

  test('refreshes a visible workspace once per authoritative run signal and not on unrelated rerenders', async () => {
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    expect(workspaceRequests).toHaveLength(0)

    await act(async () => {
      findAgentRunTab('workspace')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(workspaceRequests).toEqual(['turn-public'])

    await act(async () => {
      useStore.setState({ agentRunOmittedEventsByChat: { 'chat-public': 1 } })
      await Promise.resolve()
    })
    expect(workspaceRequests).toHaveLength(1)

    const liveRun = { ...terminalRun(), sequence: 10, revision: 5 }
    await act(async () => {
      useStore.setState({ agentRunTerminalByTarget: { 'chat-public:message-public:1': liveRun } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(workspaceRequests).toEqual(['turn-public', 'turn-public'])

    const recoveredRun = { ...liveRun, revision: 6 }
    await act(async () => {
      useStore.setState({ agentRunTerminalByTarget: { 'chat-public:message-public:1': recoveredRun } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(workspaceRequests).toEqual(['turn-public', 'turn-public', 'turn-public'])

    await act(async () => {
      useStore.setState({ agentRunOmittedEventsByChat: { 'chat-public': 2 } })
      await Promise.resolve()
    })
    expect(workspaceRequests).toHaveLength(3)
  })
  test('terminalizes a malformed workspace index without refetching on rerender', async () => {
    invalidWorkspaceIndexResponse = true
    const workspace = useStore.getState().agentWorkspaceByTurn['turn-public']!
    useStore.setState({
      agentWorkspaceByTurn: {
        ...useStore.getState().agentWorkspaceByTurn,
        'turn-public': { ...workspace, status: 'idle', index: null, sections: {}, error: false },
      },
    })
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    await act(async () => findAgentRunTab('workspace')?.click())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(workspaceRequests).toEqual(['turn-public'])
    expect(useStore.getState().agentWorkspaceByTurn['turn-public']).toMatchObject({ status: 'error', error: true })
    expect(document.body.textContent).toContain('The workspace could not be loaded.')

    await act(async () => {
      useStore.setState({ agentRunOmittedEventsByChat: { 'chat-public': 1 } })
      await Promise.resolve()
    })
    expect(workspaceRequests).toHaveLength(1)
  })
  test('reloads an expanded section after a newer workspace index revision', async () => {
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    await act(async () => findAgentRunTab('workspace')?.click())
    const taskToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Tasks'))!
    await act(async () => taskToggle.click())
    expect(workspaceSectionRequests).toHaveLength(0)

    const workspace = useStore.getState().agentWorkspaceByTurn['turn-public']!
    await act(async () => {
      useStore.setState({
        agentWorkspaceByTurn: {
          ...useStore.getState().agentWorkspaceByTurn,
          'turn-public': {
            ...workspace,
            index: {
              ...workspace.index!,
              workspaceRevision: 8,
              sections: workspace.index!.sections.map((summary) => (
                summary.section === 'tasks' ? { ...summary, revision: 8 } : summary
              )),
            },
          },
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(workspaceSectionRequests).toEqual([{
      turnId: 'turn-public',
      section: 'tasks',
      revision: 8,
    }])
    expect(useStore.getState().agentWorkspaceByTurn['turn-public'].sections.tasks?.preview.workspaceRevision).toBe(8)
  })
  test('does not let an old in-flight section request absorb a newer index revision', async () => {
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    await act(async () => findAgentRunTab('workspace')?.click())
    const taskToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Tasks'))!
    await act(async () => taskToggle.click())

    const workspace = useStore.getState().agentWorkspaceByTurn['turn-public']!
    deferWorkspaceSection = true
    await act(async () => {
      useStore.setState({
        agentWorkspaceByTurn: {
          ...useStore.getState().agentWorkspaceByTurn,
          'turn-public': {
            ...workspace,
            index: { ...workspace.index!, workspaceRevision: 8 },
            sections: {},
          },
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      const current = useStore.getState().agentWorkspaceByTurn['turn-public']!
      useStore.setState({
        agentWorkspaceByTurn: {
          ...useStore.getState().agentWorkspaceByTurn,
          'turn-public': {
            ...current,
            index: { ...current.index!, workspaceRevision: 9 },
            sections: {},
          },
        },
      })
      await Promise.resolve()
    })
    expect(workspaceSectionRequests.map((request) => request.revision)).toEqual([8, 9])

    const pending = pendingWorkspaceSections.splice(0)
    await act(async () => {
      deferWorkspaceSection = false
      for (const resolve of pending) resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useStore.getState().agentWorkspaceByTurn['turn-public'].sections.tasks?.preview.workspaceRevision).toBe(9)
  })


  test('shows a retry action after the first section request fails', async () => {
    await renderActivity()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click())
    await act(async () => findAgentRunTab('workspace')?.click())
    const workspace = useStore.getState().agentWorkspaceByTurn['turn-public']!
    await act(async () => {
      useStore.setState({
        agentWorkspaceByTurn: {
          ...useStore.getState().agentWorkspaceByTurn,
          'turn-public': { ...workspace, sections: { ...workspace.sections, tasks: undefined } },
        },
      })
      await Promise.resolve()
    })
    failWorkspaceSection = true
    const taskToggle = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Tasks'))!
    await act(async () => {
      taskToggle.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('The workspace could not be loaded.')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry')!
    await act(async () => {
      retry.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('No public entries in this section.')
  })
})
