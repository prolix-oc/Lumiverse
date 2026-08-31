import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import * as actualReactI18next from 'react-i18next'
import { createInstance } from 'i18next'
import type { AgentRunStopResultV2 } from '@/types/agent-runs'
const stopCalls: Array<{ turnId: string; input?: { generationId?: string; chatId?: string; requestAuthorityId?: string } }> = []
const pendingStops: Array<{
  promise: Promise<AgentRunStopResultV2>
  resolve(value: AgentRunStopResultV2): void
  reject(reason?: unknown): void
}> = []

mock.module('@/api/agent-runs', () => ({
  agentRunsApi: {
    stop(turnId: string, input?: { generationId?: string; chatId?: string; requestAuthorityId?: string }) {
      stopCalls.push({ turnId, input })
      const pending = Promise.withResolvers<AgentRunStopResultV2>()
      pendingStops.push(pending)
      return pending.promise
    },
  },
}))
// Preserve the complete module shape for Activity tests sharing this graph.
mock.module('react-i18next', () => ({ ...actualReactI18next }))
const testI18n = createInstance()
await testI18n.init({
  resources: { en: { chat: {} } },
  lng: 'en',
  fallbackLng: false,
  interpolation: { escapeValue: false },
})
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

// The API mock must be installed before the component captures it.
const { default: AgentRunStopButton } = await import('./AgentRunStopButton')
const { createRoot } = await import('react-dom/client')
mock.restore()
const mountedRoots = new Set<Root>()

type RenderStopButtonOptions = {
  turnId?: string
  chatId?: string
  generationId?: string
  requestAuthorityId?: string
  terminal?: boolean
  onBeforeStop?: () => void
  onResult?: (result: AgentRunStopResultV2) => void
  onSettled?: () => void
}

async function renderStopButton(
  options: RenderStopButtonOptions | boolean = {},
): Promise<{ host: HTMLDivElement; root: Root; render(nextOptions?: RenderStopButtonOptions): Promise<void> }> {
  const initialOptions = typeof options === 'boolean' ? { terminal: options } : options
  let props: {
    turnId: string
    chatId: string
    generationId: string
    requestAuthorityId: string
    terminal: boolean
    onBeforeStop?: () => void
    onResult?: (result: AgentRunStopResultV2) => void
    onSettled?: () => void
  } = {
    turnId: initialOptions.turnId ?? 'turn-1',
    chatId: initialOptions.chatId ?? 'chat-1',
    generationId: initialOptions.generationId ?? 'generation-1',
    requestAuthorityId: initialOptions.requestAuthorityId ?? '11111111-1111-4111-8111-111111111111',
    terminal: initialOptions.terminal ?? false,
    onBeforeStop: initialOptions.onBeforeStop,
    onResult: initialOptions.onResult,
    onSettled: initialOptions.onSettled,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  const render = async (nextOptions: RenderStopButtonOptions = {}): Promise<void> => {
    props = {
      turnId: nextOptions.turnId ?? props.turnId,
      chatId: nextOptions.chatId ?? props.chatId,
      generationId: nextOptions.generationId ?? props.generationId,
      requestAuthorityId: nextOptions.requestAuthorityId ?? props.requestAuthorityId,
      terminal: nextOptions.terminal === undefined ? props.terminal : nextOptions.terminal,
      onBeforeStop: nextOptions.onBeforeStop === undefined ? props.onBeforeStop : nextOptions.onBeforeStop,
      onResult: nextOptions.onResult === undefined ? props.onResult : nextOptions.onResult,
      onSettled: nextOptions.onSettled === undefined ? props.onSettled : nextOptions.onSettled,
    }
    await act(async () => {
      root.render(
        <actualReactI18next.I18nextProvider i18n={testI18n}>
          <AgentRunStopButton {...props} />
        </actualReactI18next.I18nextProvider>,
      )
    })
  }
  await render()
  return { host, root, render }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  stopCalls.length = 0
  pendingStops.length = 0
})

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount())
  }
  mountedRoots.clear()
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
  dom.window.close()
})

describe('AgentRunStopButton', () => {
  test('targets the exact root once, immediately shows Stopping, and disables duplicates', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!

    await act(async () => {
      button.click()
      button.click()
    })

    expect(stopCalls).toEqual([{
      turnId: 'turn-1',
      input: { chatId: 'chat-1', generationId: 'generation-1', requestAuthorityId: '11111111-1111-4111-8111-111111111111' },
    }])
    expect(button.disabled).toBeTrue()
    expect(button.textContent).toContain('agentRuntime.stop.stopping')

    await act(async () => {
      pendingStops[0].resolve({
        version: 2,
        status: 'accepted',
        turnId: 'turn-1',
        revision: 2,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'cancelling',
        workOutcome: null,
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-1',
      })
      await settle()
    })
    expect(button.disabled).toBeTrue()
    expect(button.dataset.stopState).toBe('stopping')
  })

  test('enables the replacement generation while the previous stop is pending', async () => {
    const { host, render } = await renderStopButton()
    const oldButton = host.querySelector('button')!
    await act(async () => oldButton.click())

    await render({ generationId: 'generation-2' })
    const newButton = host.querySelector('button')!
    expect(newButton.disabled).toBeFalse()
    expect(newButton.dataset.stopState).toBe('idle')

    await act(async () => newButton.click())
    expect(stopCalls).toEqual([
      { turnId: 'turn-1', input: { chatId: 'chat-1', generationId: 'generation-1', requestAuthorityId: '11111111-1111-4111-8111-111111111111' } },
      { turnId: 'turn-1', input: { chatId: 'chat-1', generationId: 'generation-2', requestAuthorityId: '11111111-1111-4111-8111-111111111111' } },
    ])
  })

  test('keeps request ownership when only the terminal view changes', async () => {
    let settledCount = 0
    const { host, render } = await renderStopButton({
      onSettled: () => { settledCount += 1 },
    })
    const button = host.querySelector('button')!
    await act(async () => button.click())

    await render({ terminal: true })
    expect(button.dataset.stopState).toBe('terminal')
    expect(button.disabled).toBeTrue()
    await act(async () => {
      pendingStops[0].resolve({
        version: 2,
        status: 'accepted',
        turnId: 'turn-1',
        revision: 2,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'cancelling',
        workOutcome: null,
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-terminal',
      })
      await settle()
    })

    expect(settledCount).toBe(1)
    await render({ terminal: false })
    expect(button.dataset.stopState).toBe('stopping')
    expect(button.disabled).toBeTrue()
    expect(stopCalls).toHaveLength(1)
  })

  test('ignores a stale success from the previous generation', async () => {
    const resultCalls: AgentRunStopResultV2[] = []
    let settledCount = 0
    const { host, render } = await renderStopButton({
      onResult: result => resultCalls.push(result),
      onSettled: () => { settledCount += 1 },
    })
    await act(async () => host.querySelector('button')!.click())
    await render({ generationId: 'generation-2' })
    const newButton = host.querySelector('button')!
    await act(async () => newButton.click())

    await act(async () => {
      pendingStops[0].resolve({
        version: 2,
        status: 'accepted',
        turnId: 'turn-1',
        revision: 2,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'cancelling',
        workOutcome: null,
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-old',
      })
      await settle()
    })

    expect(resultCalls).toHaveLength(0)
    expect(settledCount).toBe(0)
    await act(async () => {
      pendingStops[1].resolve({
        version: 2,
        status: 'accepted',
        turnId: 'turn-1',
        revision: 3,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'cancelling',
        workOutcome: null,
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-new',
      })
      await settle()
    })

    expect(resultCalls.map(result => result.inspectionAttemptId)).toEqual(['inspection-new'])
    expect(settledCount).toBe(1)
    expect(newButton.dataset.stopState).toBe('stopping')
    expect(newButton.disabled).toBeTrue()
  })

  test('ignores a stale rejection from the previous generation', async () => {
    let settledCount = 0
    const { host, render } = await renderStopButton({
      onSettled: () => { settledCount += 1 },
    })
    await act(async () => host.querySelector('button')!.click())
    await render({ generationId: 'generation-2' })
    const newButton = host.querySelector('button')!
    await act(async () => newButton.click())

    await act(async () => {
      pendingStops[0].reject(new Error('old network failure'))
      await settle()
    })

    expect(settledCount).toBe(0)
    expect(newButton.dataset.stopState).toBe('stopping')
    expect(newButton.disabled).toBeTrue()
    await act(async () => {
      pendingStops[1].reject(new Error('new network failure'))
      await settle()
    })

    expect(settledCount).toBe(1)
    expect(newButton.dataset.stopState).toBe('error')
    expect(newButton.disabled).toBeFalse()
  })

  test('ignores a pending settlement after unmount', async () => {
    const resultCalls: AgentRunStopResultV2[] = []
    let settledCount = 0
    const { host, root } = await renderStopButton({
      onResult: result => resultCalls.push(result),
      onSettled: () => { settledCount += 1 },
    })
    await act(async () => host.querySelector('button')!.click())
    await act(async () => root.unmount())
    mountedRoots.delete(root)

    await act(async () => {
      pendingStops[0].resolve({
        version: 2,
        status: 'accepted',
        turnId: 'turn-1',
        revision: 2,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'WORK',
        workStatus: 'cancelling',
        workOutcome: null,
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-unmounted',
      })
      await settle()
    })

    expect(resultCalls).toHaveLength(0)
    expect(settledCount).toBe(0)
  })

  test('enables a retry after request failure', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!
    await act(async () => button.click())
    await act(async () => {
      pendingStops[0].reject(new Error('network'))
      await settle()
    })

    expect(button.disabled).toBeFalse()
    expect(button.textContent).toContain('agentRuntime.stop.retry')

    await act(async () => button.click())
    expect(stopCalls).toHaveLength(2)
  })

  test('renders too_late explicitly and leaves the action disabled', async () => {
    const { host } = await renderStopButton()
    const button = host.querySelector('button')!
    await act(async () => button.click())
    await act(async () => {
      pendingStops[0].resolve({
        version: 2,
        status: 'too_late',
        turnId: 'turn-1',
        revision: 3,
        target: { chatId: 'chat-1', generationType: 'normal', messageId: null, swipeId: null },
        workPhase: 'TERMINAL',
        workStatus: 'terminal',
        workOutcome: 'completed',
        reason: null,
        recoveryEligible: false,
        recoveryAction: 'none',
        omissionCount: 0,
        inspectionAttemptId: 'inspection-1',
      })
      await settle()
    })

    expect(button.dataset.stopState).toBe('too_late')
    expect(button.textContent).toContain('agentRuntime.stop.tooLate')
    expect(button.disabled).toBeTrue()
  })

  test('does not create a second live region beside the chat-level run announcer', async () => {
    const { host } = await renderStopButton(true)
    const button = host.querySelector('button')!
    expect(button.dataset.stopState).toBe('terminal')
    expect(button.disabled).toBeTrue()
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})
