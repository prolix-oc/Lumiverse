import { expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { Root } from 'react-dom/client'
import chat from '@/i18n/locales/en/chat.json'
import type {
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
} from '@/types/agent-runs'

const detachedWorkspace: AgentPersistentWorkspaceV1 = {
  version: 1,
  id: 'workspace-detached',
  userId: 'user-a',
  chatId: null,
  objective: 'Preserve detached work',
  metadata: {
    title: 'Detached workspace',
    summary: 'Historical workspace',
    labels: [],
    ownerNote: '',
  },
  progress: {
    state: 'completed',
    percent: 100,
    summary: 'Complete',
    updatedAt: 1_100,
  },
  state: 'active',
  revision: 1,
  quota: {
    maxTasks: 10,
    maxRecords: 10,
    maxSubmissions: 10,
    maxArtifacts: 10,
    maxPublications: 10,
    maxBytes: 1_000_000,
  },
  usage: {
    taskCount: 1,
    recordCount: 0,
    submissionCount: 0,
    artifactCount: 0,
    publicationCount: 0,
    byteCount: 0,
  },
  createdAt: 1_000,
  updatedAt: 1_100,
}

const detachedSession: AgentPersistentWorkspaceTurnSessionV1 = {
  version: 1,
  id: 'session-detached',
  workspaceId: detachedWorkspace.id,
  userId: 'user-a',
  chatId: null,
  turnId: 'turn-detached',
  attemptId: 'attempt-detached',
  executionId: null,
  phase: 'TERMINAL',
  status: 'terminal',
  outcome: 'completed',
  revision: 1,
  createdAt: 1_000,
  updatedAt: 1_100,
  terminalAt: 1_100,
}

test('renders detached workspace and retained session source fallback', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousNavigator = globalThis.navigator
  const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = runtime.IS_REACT_ACT_ENVIRONMENT
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
  })
  runtime.IS_REACT_ACT_ENVIRONMENT = true

  let root: Root | null = null
  let host: HTMLDivElement | null = null
  let loadMoreCalls = 0
  try {
    // ReactDOM captures browser globals at module evaluation; import after JSDOM setup.
    const { createRoot } = await import('react-dom/client')
    const { PersistentWorkspaceInspector } = await import('./PersistentWorkspaceInspector')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { chat } },
      interpolation: { escapeValue: false },
    })
    const container = document.createElement('div')
    host = container
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <PersistentWorkspaceInspector
            workspace={detachedWorkspace}
            sessions={[detachedSession]}
            sessionsTotal={2}
            onLoadMoreSessions={() => { loadMoreCalls += 1 }}
            onRefresh={() => {}}
            onEdit={() => {}}
            onCreateTask={() => {}}
            onPublish={() => {}}
            onDeletePublication={() => {}}
            onDeleteWorkspace={() => {}}
          />
        </I18nextProvider>,
      )
    })

    expect(container.textContent).toContain('Source chat deleted')
    const buttons = [...container.querySelectorAll('button')]
    const saveButton = buttons.find((button) => button.textContent?.includes('Save changes'))
    const deleteButton = buttons.find((button) => button.textContent?.includes('Delete workspace'))
    expect(saveButton).toBeDefined()
    expect((saveButton as HTMLButtonElement).disabled).toBe(true)
    expect(deleteButton).toBeDefined()
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false)
    expect(container.textContent).toContain('turn-detached')
    const showMoreButton = buttons.find((button) => button.textContent?.includes('Show more Turn Sessions'))
    expect(showMoreButton).toBeDefined()
    expect(container.textContent).toContain('Showing 1 of 2 linked Turn Sessions')
    await act(async () => {
      ;(showMoreButton as HTMLButtonElement).click()
    })
    expect(loadMoreCalls).toBe(1)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    host?.remove()
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      navigator: previousNavigator,
    })
    if (previousActEnvironment === undefined) delete runtime.IS_REACT_ACT_ENVIRONMENT
    else runtime.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
