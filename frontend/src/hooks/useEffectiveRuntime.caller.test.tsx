import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import * as runtime from '@/lib/agentRuntimeSelection'
import type {
  AgentRuntimeMode,
  ChatAgentModeWriteV1,
  EffectiveRuntimePublicResponseV1,
  GenerationTargetV1,
  LoomRuntimePolicyV1,
} from '@/types/effective-runtime'
const target: GenerationTargetV1 = {
  generationType: 'normal',
  messageId: null,
  swipeId: null,
  branchId: null,
  targetCharacterId: null,
  revision: null,
}
const runtimePolicy: LoomRuntimePolicyV1 = {
  version: 1,
  authoredValue: 'response',
  effectiveValue: 'response',
  source: 'response_fallback',
  scope: 'fallback',
  cap: { authority: 'host', allowedModes: ['response'], reasonCode: null },
  availability: { state: 'available', reasonCode: null },
  presetRevision: null,
  transientSelection: null,
  durableChatOverride: null,
  repairAcknowledgement: {
    state: 'not_required',
    presetRevision: null,
    reasonCode: null,
    acknowledgedAt: null,
  },
  nextTurnOnly: true,
}

function response(chatId: string, revision: number | null): EffectiveRuntimePublicResponseV1 {
  const responseOmission: NonNullable<EffectiveRuntimePublicResponseV1['responseOmission']> = {
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds: [],
    source: [],
    omittedPhaseInstructions: [],
  }
  return {
    version: 1,
    chatId,
    target,
    connection: {
      id: null,
      label: null,
      provider: null,
      model: null,
      revision: null,
      endpointRevision: null,
      credentialRevision: null,
      candidateRevision: null,
    },
    preset: { id: null, label: null, revision: null, source: 'none' },
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'response',
    requestedMode: 'response',
    effectiveMode: 'response',
    inspection: {
      version: 1,
      surface: 'RESPONSE',
      checkpoint: 'ASSEMBLE',
      items: [],
      effectiveEntryIds: [],
      responseOmission,
    },
    responseOmission,
    runtimePolicy,
    chatOverride: revision === null ? null : { mode: 'agentic', revision, state: 'ready' },
    capabilityReadiness: {
      ready: true,
      sameDomain: true,
      required: [],
      missing: [],
      repairCodes: [],
      responseEscape: 'available',
    },
    repairCodes: [],
    runtimeDecisionToken: null,
    runtimeDecisionExpiresAt: null,
  }
}

type ChatModeResponse = {
  chatId: string
  mode: AgentRuntimeMode | null
  revision: number
  state: 'ready'
}

function deferred<T>() {
  let settle!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    settle = resolvePromise
    reject = rejectPromise
  })
  return { promise, settle, reject }
}


const resolve = mock((_request: unknown, _options?: unknown) => Promise.resolve(response('chat-1', null)))
const setChatMode = mock(async (chatId: string, input: ChatAgentModeWriteV1) => ({
  chatId,
  mode: input.mode,
  revision: 1,
  state: 'ready' as const,
}))
const dependencies = { resolve, setChatMode }


const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['HTMLElement', globalObject.HTMLElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const { useEffectiveRuntime } = await import('./useEffectiveRuntime')
const { createRoot } = await import('react-dom/client')

type HookSurface = ReturnType<typeof useEffectiveRuntime>
let surface: HookSurface
let root: Root | null = null
let host: HTMLDivElement | null = null
let currentChatId = 'chat-1'
let currentGenerationType = 'normal'
let currentMessageId: string | null = null
let currentSwipeId: number | null = null
let currentBranchId: string | null = null
let currentTargetCharacterId: string | null = null
let currentLogicalConnectionId: string | null = null
let currentPresetId: string | null = null
let currentForcePresetId: boolean | undefined
let currentPersonaId: string | null = null
let currentSupported = true

function HookHarness() {
  surface = useEffectiveRuntime({
    chatId: currentChatId,
    generationType: currentGenerationType,
    messageId: currentMessageId,
    swipeId: currentSwipeId,
    branchId: currentBranchId,
    targetCharacterId: currentTargetCharacterId,
    logicalConnectionId: currentLogicalConnectionId,
    presetId: currentPresetId,
    forcePresetId: currentForcePresetId,
    personaId: currentPersonaId,
    supported: currentSupported,
    dependencies,
  })
  return null

}
let secondarySurface: HookSurface
function MultiHookHarness() {
  surface = useEffectiveRuntime({
    chatId: 'chat-1',
    generationType: 'normal',
    supported: true,
    dependencies,
  })
  secondarySurface = useEffectiveRuntime({
    chatId: 'chat-2',
    generationType: 'normal',
    supported: true,
    dependencies,
  })
  return null
}
async function render() {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(createElement(HookHarness))
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  runtime.resetAgentRuntimeSelectionForTests()
  resolve.mockReset()
  setChatMode.mockReset()
  resolve.mockResolvedValue(response('chat-1', null))
  setChatMode.mockImplementation(async (chatId: string, input: ChatAgentModeWriteV1) => ({
    chatId,
    mode: input.mode,
    revision: 1,
    state: 'ready' as const,
  }))
  currentMessageId = null
  currentSwipeId = null
  currentBranchId = null
  currentTargetCharacterId = null
  currentLogicalConnectionId = null
  currentPresetId = null
  currentForcePresetId = undefined
  currentPersonaId = null
  currentSupported = true
  currentGenerationType = 'normal'
  currentChatId = 'chat-1'
})

const scopeChanges: Array<[string, () => void]> = [
  ['chat', () => { currentChatId = 'chat-2' }],
  ['generation type', () => { currentGenerationType = 'continue' }],
  ['message', () => { currentMessageId = 'message-2' }],
  ['swipe', () => { currentSwipeId = 1 }],
  ['branch', () => { currentBranchId = 'branch-2' }],
  ['target character', () => { currentTargetCharacterId = 'character-2' }],
  ['logical connection', () => { currentLogicalConnectionId = 'connection-2' }],
  ['preset', () => { currentPresetId = 'preset-2' }],
  ['force preset', () => { currentForcePresetId = true }],
  ['persona', () => { currentPersonaId = 'persona-2' }],
  ['support', () => { currentSupported = false }],
]

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useEffectiveRuntime chat override CAS caller', () => {
  test('sends zero for a first write, including an explicit null-mode write', async () => {
    await render()
    await act(async () => {
      await surface.saveChatOverride(null)
    })

    expect(setChatMode).toHaveBeenCalledWith('chat-1', { mode: null, expectedRevision: 0 })
  })

  test('uses the revision returned by a successful write when refresh fails', async () => {
    await render()
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    resolve.mockRejectedValueOnce(new Error('refresh failed'))

    await act(async () => {
      await surface.saveChatOverride('agentic')
    })
    await act(async () => {
      await surface.saveChatOverride(null)
    })
    expect(setChatMode.mock.calls[1]?.[1]).toEqual({ mode: null, expectedRevision: 5 })
  })

  test('does not carry a previous chat revision into a new chat write', async () => {
    resolve.mockResolvedValue(response('chat-1', 9))
    await render()
    currentChatId = 'chat-2'
    resolve.mockResolvedValue(response('chat-2', null))
    await render()

    await act(async () => {
      await surface.saveChatOverride('agentic')
    })
    expect(setChatMode.mock.calls.at(-1)?.[1]).toEqual({ mode: 'agentic', expectedRevision: 0 })
  })

  test('retains each chat revision when another chat is saved', async () => {
    await render()
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    resolve.mockRejectedValueOnce(new Error('chat 1 refresh failed'))
    await act(async () => {
      await surface.saveChatOverride('agentic')
    })

    currentChatId = 'chat-2'
    resolve.mockResolvedValue(response('chat-2', null))
    await render()
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-2', mode: 'agentic', revision: 7, state: 'ready' })
    await act(async () => {
      await surface.saveChatOverride('agentic')
    })

    currentChatId = 'chat-1'
    resolve.mockResolvedValue(response('chat-1', null))
    await render()
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: null, revision: 6, state: 'ready' })
    await act(async () => {
      await surface.saveChatOverride(null)
    })

    expect(setChatMode.mock.calls.at(-1)?.[1]).toEqual({ mode: null, expectedRevision: 5 })
  })

  test('reads the successful revision synchronously across concurrent saves', async () => {
    await render()
    const firstWrite = deferred<ChatModeResponse>()
    const secondWrite = deferred<ChatModeResponse>()
    setChatMode
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
    resolve.mockResolvedValue(response('chat-1', null))

    let firstSave!: Promise<void>
    let secondSave!: Promise<void>
    await act(async () => {
      firstSave = surface.saveChatOverride('agentic')
      secondSave = surface.saveChatOverride(null)
      await Promise.resolve()
    })
    expect(setChatMode).toHaveBeenCalledTimes(2)

    secondWrite.settle({ chatId: 'chat-1', mode: null, revision: 6, state: 'ready' })
    let secondSaveSettled = false
    void secondSave.then(
      () => { secondSaveSettled = true },
      () => { secondSaveSettled = true },
    )
    await Promise.resolve()
    expect(secondSaveSettled).toBe(false)
    firstWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    await act(async () => {
      await Promise.all([firstSave, secondSave])
    })

    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 7, state: 'ready' })
    await act(async () => {
      await surface.saveChatOverride('agentic')
    })
    expect(setChatMode.mock.calls.at(-1)?.[1]).toEqual({ mode: 'agentic', expectedRevision: 6 })
  })

  test('does not refresh a stale target after a pending save settles', async () => {
    await render()
    const pendingWrite = deferred<ChatModeResponse>()
    setChatMode.mockImplementationOnce(() => pendingWrite.promise)

    let save!: Promise<void>
    await act(async () => {
      save = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })

    currentMessageId = 'message-2'
    await render()
    const resolveCallsAfterTargetSwitch = resolve.mock.calls.length
    pendingWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    await act(async () => {
      await save
    })

    expect(resolve.mock.calls.length).toBe(resolveCallsAfterTargetSwitch)
  })

  test('does not let an older save refresh overwrite a newer same-target save', async () => {
    await render()
    const firstRefresh = deferred<EffectiveRuntimePublicResponseV1>()
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: null, revision: 6, state: 'ready' })
    resolve.mockImplementationOnce(() => firstRefresh.promise)

    let firstSave!: Promise<void>
    await act(async () => {
      firstSave = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })

    let secondSave!: Promise<void>
    await act(async () => {
      secondSave = surface.saveChatOverride(null)
      await Promise.resolve()
    })
    let secondSaveSettled = false
    void secondSave.then(
      () => { secondSaveSettled = true },
      () => { secondSaveSettled = true },
    )
    await Promise.resolve()
    expect(secondSaveSettled).toBe(false)
    firstRefresh.settle(response('chat-1', 5))
    await act(async () => {
      await secondSave
      await firstSave
    })
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision?.chatOverride).toBeNull()
    expect(setChatMode.mock.calls[1]?.[1]).toEqual({ mode: null, expectedRevision: 5 })
  })

  test('keeps the shared drain open when a write settles during reconciliation', async () => {
    await render()
    const firstRefresh = deferred<EffectiveRuntimePublicResponseV1>()
    const resolveCallsBeforeSave = resolve.mock.calls.length
    resolve
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(response('chat-1', null))
    setChatMode
      .mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
      .mockResolvedValueOnce({ chatId: 'chat-1', mode: null, revision: 6, state: 'ready' })

    let firstSave!: Promise<void>
    await act(async () => {
      firstSave = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })
    let secondSave!: Promise<void>
    await act(async () => {
      secondSave = surface.saveChatOverride(null)
      await Promise.resolve()
    })
    let secondSaveSettled = false
    void secondSave.then(
      () => { secondSaveSettled = true },
      () => { secondSaveSettled = true },
    )
    await Promise.resolve()
    expect(secondSaveSettled).toBe(false)

    firstRefresh.settle(response('chat-1', 5))
    await act(async () => {
      await firstSave
      await secondSave
    })
    expect(resolve.mock.calls.length).toBe(resolveCallsBeforeSave + 2)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision?.chatOverride).toBeNull()
  })

  test('retries reconciliation when a public refresh supersedes its response', async () => {
    await render()
    const drainRefresh = deferred<EffectiveRuntimePublicResponseV1>()
    const publicRefresh = deferred<EffectiveRuntimePublicResponseV1>()
    const resolveCallsBeforeSave = resolve.mock.calls.length
    resolve
      .mockImplementationOnce(() => drainRefresh.promise)
      .mockImplementationOnce(() => publicRefresh.promise)
      .mockResolvedValue(response('chat-1', null))
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })

    let save!: Promise<void>
    await act(async () => {
      save = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })
    let publicResolve!: Promise<void>
    await act(async () => {
      publicResolve = surface.refresh()
      await Promise.resolve()
    })
    drainRefresh.settle(response('chat-1', 5))
    await act(async () => {
      await save
    })
    expect(resolve.mock.calls.length).toBe(resolveCallsBeforeSave + 3)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision?.chatOverride).toBeNull()
    publicRefresh.settle(response('chat-1', 5))
    await act(async () => {
      await publicResolve
    })
  })

  test('closes the drain barrier when authoritative refresh rejects', async () => {
    await render()
    const refreshError = new Error('refresh failed')
    resolve.mockRejectedValueOnce(refreshError)
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })

    await act(async () => {
      await surface.saveChatOverride('agentic')
    })
    expect(surface.savingOverride).toBe(false)
    expect(surface.error).toBe(refreshError)
  })

  test('closes an in-flight drain barrier on unmount', async () => {
    await render()
    const pendingRefresh = deferred<EffectiveRuntimePublicResponseV1>()
    resolve.mockImplementationOnce(() => pendingRefresh.promise)
    setChatMode.mockResolvedValueOnce({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })

    let save!: Promise<void>
    await act(async () => {
      save = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })
    let saveSettled = false
    void save.then(
      () => { saveSettled = true },
      () => { saveSettled = true },
    )
    await Promise.resolve()
    expect(saveSettled).toBe(false)

    act(() => root?.unmount())
    root = null
    await act(async () => {
      await save
    })
    expect(saveSettled).toBe(true)
    pendingRefresh.settle(response('chat-1', 5))
  })

  test('reconciles an older successful write when the newer save fails', async () => {
    await render()
    const firstWrite = deferred<ChatModeResponse>()
    const secondWrite = deferred<ChatModeResponse>()
    setChatMode
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
    resolve.mockResolvedValue(response('chat-1', 5))

    let firstSave!: Promise<void>
    let secondSave!: Promise<void>
    await act(async () => {
      firstSave = surface.saveChatOverride('agentic')
      secondSave = surface.saveChatOverride(null)
      await Promise.resolve()
    })
    firstWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    const failure = new Error('newer CAS conflict')
    secondWrite.reject(failure)
    let observedFailure: unknown
    const secondFailure = secondSave.catch((cause) => {
      observedFailure = cause
    })
    await act(async () => {
      await firstSave
      await secondFailure
    })

    expect(observedFailure).toBe(failure)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision?.chatOverride?.revision).toBe(5)
    expect(setChatMode.mock.calls[1]?.[1]).toEqual({ mode: null, expectedRevision: 0 })
  })

  test('reconciles when the newer failure settles before the older success', async () => {
    await render()
    const firstWrite = deferred<ChatModeResponse>()
    const secondWrite = deferred<ChatModeResponse>()
    setChatMode
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
    resolve.mockResolvedValue(response('chat-1', 5))

    let firstSave!: Promise<void>
    let secondSave!: Promise<void>
    await act(async () => {
      firstSave = surface.saveChatOverride('agentic')
      secondSave = surface.saveChatOverride(null)
      await Promise.resolve()
    })

    const failure = new Error('newer CAS conflict')
    secondWrite.reject(failure)
    let observedFailure: unknown
    const secondFailure = secondSave.catch((cause) => {
      observedFailure = cause
    })
    firstWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    await act(async () => {
      await firstSave
      await secondFailure
    })
    expect(observedFailure).toBe(failure)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision?.chatOverride?.revision).toBe(5)
    expect(setChatMode.mock.calls[1]?.[1]).toEqual({ mode: null, expectedRevision: 0 })
  })

  test('drains a timed-out PUT and clears saving state', async () => {
    await render()
    const timeout = new Error('timeout')
    setChatMode.mockRejectedValueOnce(timeout)
    let observedFailure: unknown
    await act(async () => {
      try {
        await surface.saveChatOverride('agentic')
      } catch (cause) {
        observedFailure = cause
      }
    })

    expect(observedFailure).toBe(timeout)
    expect(surface.savingOverride).toBe(false)
    expect(surface.error).toBe(timeout)
  })

  test('does not reconcile a settled PUT after unmount', async () => {
    await render()
    const pendingWrite = deferred<ChatModeResponse>()
    setChatMode.mockImplementationOnce(() => pendingWrite.promise)
    let save!: Promise<void>
    await act(async () => {
      save = surface.saveChatOverride('agentic')
      await Promise.resolve()
    })
    const resolveCallsBeforeUnmount = resolve.mock.calls.length
    act(() => root?.unmount())
    root = null
    pendingWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
    await act(async () => {
      await save
    })
    expect(resolve.mock.calls.length).toBe(resolveCallsBeforeUnmount)
  })

  test('shows the selector from availability when Agentic admission is still closed', async () => {
    resolve.mockResolvedValue({
      ...response('chat-1', null),
      agentsEnabled: true,
      allowedModes: ['response', 'agentic'],
      capabilityReadiness: {
        ready: false,
        sameDomain: true,
        required: [],
        missing: [],
        repairCodes: ['agentic_kill_switch'],
        responseEscape: 'available',
      },
      repairCodes: ['agentic_kill_switch'],
    })
    await render()
    expect(surface.canShowSelector).toBe(true)
    expect(surface.repairCategories).toContain('readiness')
  })

  test('refetches active and inactive chat projections while fencing both stale pre-commit responses', async () => {
    const requestChatId = (request: unknown) => (request as { chatId: string }).chatId
    resolve.mockImplementation(async (request: unknown) => response(requestChatId(request), 1))
    if (!host) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(createElement(MultiHookHarness))
      await Promise.resolve()
      await Promise.resolve()
    })

    const staleActive = deferred<EffectiveRuntimePublicResponseV1>()
    const staleInactive = deferred<EffectiveRuntimePublicResponseV1>()
    resolve
      .mockImplementationOnce(() => staleActive.promise)
      .mockImplementationOnce(() => staleInactive.promise)
      .mockImplementation(async (request: unknown) => {
        const chatId = requestChatId(request)
        return response(chatId, chatId === 'chat-1' ? 9 : 10)
      })

    let oldActive!: Promise<void>
    let oldInactive!: Promise<void>
    await act(async () => {
      oldActive = surface.refresh()
      oldInactive = secondarySurface.refresh()
      await Promise.resolve()
      runtime.commitRuntimeAuthorityMutation()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(surface.decision?.chatId).toBe('chat-1')
    expect(surface.decision?.chatOverride?.revision).toBe(9)
    expect(secondarySurface.decision?.chatId).toBe('chat-2')
    expect(secondarySurface.decision?.chatOverride?.revision).toBe(10)

    staleActive.settle(response('chat-1', 5))
    staleInactive.settle(response('chat-2', 6))
    await act(async () => {
      await Promise.all([oldActive, oldInactive])
      await Promise.resolve()
    })
    expect(surface.decision?.chatOverride?.revision).toBe(9)
    expect(secondarySurface.decision?.chatOverride?.revision).toBe(10)
  })
  test('refetches every mounted projection and fences stale responses after authority commits', async () => {
    await render()
    const baselineCalls = resolve.mock.calls.length
    const stale = deferred<EffectiveRuntimePublicResponseV1>()
    resolve
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(response('chat-1', 9))

    await act(async () => {
      runtime.commitRuntimeAuthorityMutation()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolve.mock.calls.length).toBe(baselineCalls + 1)

    await act(async () => {
      runtime.commitRuntimeAuthorityMutation()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolve.mock.calls.length).toBe(baselineCalls + 2)
    expect(surface.decision?.chatOverride?.revision).toBe(9)

    stale.settle(response('chat-1', 5))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(surface.decision?.chatOverride?.revision).toBe(9)
  })

  for (const [label, changeScope] of scopeChanges) {
    test(`does not reconcile after ${label} changes`, async () => {
      await render()
      const pendingWrite = deferred<ChatModeResponse>()
      setChatMode.mockImplementationOnce(() => pendingWrite.promise)

      let save!: Promise<void>
      await act(async () => {
        save = surface.saveChatOverride('agentic')
        await Promise.resolve()
      })

      changeScope()
      await render()
      const resolveCallsAfterScopeChange = resolve.mock.calls.length
      pendingWrite.settle({ chatId: 'chat-1', mode: 'agentic', revision: 5, state: 'ready' })
      await act(async () => {
        await save
      })

      expect(resolve.mock.calls.length).toBe(resolveCallsAfterScopeChange)
    })
  }
})
