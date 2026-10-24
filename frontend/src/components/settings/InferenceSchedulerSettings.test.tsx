import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import type { InferenceSchedulerOverview } from '@/api/inference-scheduler'

function fixture(overrides: Partial<InferenceSchedulerOverview> = {}): InferenceSchedulerOverview {
  const base: InferenceSchedulerOverview = {
    config: {
      enabled: true,
      unifiedLocalPool: true,
      schedulePrivateNetwork: true,
      extraOrigins: [],
      excludedOrigins: [],
      groups: [],
      concurrency: 1,
      preemptBackground: true,
      agingMs: 15000,
      maxWaitMs: 0,
    },
    status: {
      enabled: true,
      host: true,
      resources: [
        {
          key: 'local:unified',
          label: 'Local inference',
          local: true,
          concurrency: 1,
          active: [
            {
              id: 'lease-1',
              userId: 'owner',
              requestClass: 'interactive',
              purpose: 'chat',
              origin: 'http://127.0.0.1:5001',
              startedAt: Date.now() - 1500,
              durationMs: 1500,
            },
          ],
          waiting: [
            {
              id: 'wait-1',
              userId: 'owner',
              requestClass: 'background',
              purpose: 'memory-cortex:analysis',
              origin: 'http://127.0.0.1:5001',
              enqueuedAt: Date.now() - 800,
              waitMs: 800,
              effectivePriority: 3,
            },
          ],
          stats: { granted: 2, completed: 1, preempted: 0, timedOut: 0, aborted: 0, lastWaitMs: 42 },
          updatedAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    },
    endpoints: [
      {
        origin: 'http://127.0.0.1:5001',
        label: 'Chat — Local llama.cpp',
        sources: ['chat', 'memory-cortex'],
        scheduled: true,
        excluded: false,
      },
      {
        origin: 'https://api.openai.com',
        label: 'Chat — Cloud',
        sources: ['chat'],
        scheduled: false,
        excluded: false,
      },
    ],
    ...overrides,
  }
  return base
}

let current = fixture()
const getOverview = mock(async () => current)
const getStatus = mock(async () => ({ config: current.config, status: current.status }))
let saveError: Error | null = null

const updateConfig = mock(async (patch: Record<string, unknown>) => {
  if (saveError) throw saveError
  current = { ...current, config: { ...current.config, ...patch } }
  return current
})

mock.module('@/api/inference-scheduler', () => ({
  inferenceSchedulerApi: { getOverview, getStatus, updateConfig },
}))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {} } }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue ?? key)
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
    },
  }),
}))

const { default: InferenceSchedulerSettings } = await import('./InferenceSchedulerSettings')

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previous: Record<string, unknown>

beforeEach(() => {
  current = fixture()
  getOverview.mockClear()
  getStatus.mockClear()
  updateConfig.mockClear()
  saveError = null

  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previous = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<InferenceSchedulerSettings />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function text(): string {
  return host.textContent ?? ''
}

test('renders detected endpoints and live queue activity', async () => {
  await render()

  expect(text()).toContain('Chat — Local llama.cpp')
  expect(text()).toContain('http://127.0.0.1:5001')
  expect(text()).toContain('Scheduled')
  expect(text()).toContain('chat')
  expect(text()).toContain('memory-cortex:analysis')
  expect(text()).toContain('1 running · 1 waiting')
})

test('excludes a scheduled endpoint through the config API', async () => {
  await render()

  const exclude = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === 'Exclude')
  expect(exclude).toBeDefined()

  await act(async () => {
    exclude!.click()
  })
  await act(async () => {
    await Promise.resolve()
  })

  expect(updateConfig).toHaveBeenCalledWith({
    excludedOrigins: ['http://127.0.0.1:5001'],
    extraOrigins: [],
  })
})

test('includes an unscheduled endpoint through the config API', async () => {
  await render()

  const include = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === 'Include')
  expect(include).toBeDefined()

  await act(async () => {
    include!.click()
  })
  await act(async () => {
    await Promise.resolve()
  })

  expect(updateConfig).toHaveBeenCalledWith({
    excludedOrigins: [],
    extraOrigins: ['https://api.openai.com'],
  })
})

test('toggles scheduling off from the master switch', async () => {
  await render()

  const master = host.querySelector('[role="switch"]')
  expect(master).toBeTruthy()

  await act(async () => {
    ;(master as HTMLElement).click()
  })
  await act(async () => {
    await Promise.resolve()
  })

  expect(updateConfig).toHaveBeenCalledWith({ enabled: false })
})

test('keeps the save error visible after rolling back to the server state', async () => {
  await render()

  saveError = new Error('scheduler save failed')
  const exclude = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === 'Exclude')
  expect(exclude).toBeDefined()

  await act(async () => {
    exclude!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(text()).toContain('scheduler save failed')
  // The optimistic change was rolled back to the server snapshot.
  const localRow = Array.from(host.querySelectorAll('li')).find((row) =>
    row.textContent?.includes('http://127.0.0.1:5001'),
  )
  expect(localRow?.textContent).toContain('Scheduled')
  expect(localRow?.textContent).not.toContain('Not scheduled')
})

test('removes a manually added origin from both config lists', async () => {
  current = fixture({
    config: {
      ...fixture().config,
      extraOrigins: ['http://10.0.0.9:5555'],
    },
    endpoints: [{
      origin: 'http://10.0.0.9:5555',
      label: 'Manual — 10.0.0.9:5555',
      sources: ['manual'],
      scheduled: true,
      excluded: false,
    }],
  })
  await render()

  const remove = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === 'Remove')
  expect(remove).toBeDefined()

  await act(async () => {
    remove!.click()
  })
  await act(async () => {
    await Promise.resolve()
  })

  expect(updateConfig).toHaveBeenCalledWith({
    extraOrigins: [],
    excludedOrigins: [],
  })
})

test('shows the empty state before anything is scheduled', async () => {
  current = fixture({
    status: { enabled: true, host: true, resources: [], updatedAt: Date.now() },
    endpoints: [],
  })
  await render()

  expect(text()).toContain('No inference endpoints are configured yet')
  expect(text()).toContain('Nothing has used a scheduled endpoint yet')
})
