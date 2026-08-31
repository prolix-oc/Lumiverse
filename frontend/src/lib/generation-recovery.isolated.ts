import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { GenerationRequestAuthority, GenerationRequestStatus } from '@/types/store'
import type { AgentRunPublicV2 } from '@/types/agent-runs'

type GenerationRequestIntent = {
  generationType: string
  targetMessageId?: string | null
  targetSwipeId?: number | null
  requestAuthorityId?: string | null
}

let generationStatus: Record<string, unknown> = { active: false }
let generationStatusImplementation = async () => generationStatus
let activityRunsImplementation = async () => ({ runs: [] as AgentRunPublicV2[] })
const providerMetadataCalls: Array<{ provider?: string | null; model?: string | null }> = []
const streamStarts: string[] = []
const generationStarts: unknown[] = []
const generationStartPaths: string[] = []
const dispatchAcknowledgements: Array<{ generationId: string; chatId: string; requestAuthorityId: string }> = []
const dispatchAcknowledgementSignals: Array<AbortSignal | undefined> = []
const generationStops: Array<{ generationId?: string; chatId?: string; requestAuthorityId?: string }> = []
const streamingErrors: string[] = []
let generationStart = Promise.withResolvers<{ generationId: string; mode?: 'response' | 'agentic' }>()
let generationAdmission = Promise.withResolvers<void>()
let generationContinuation = Promise.withResolvers<void>()
let currentProvider: string | null = null
let currentModel: string | null = null
type DispatchAcknowledgementImplementation = (
  generationId: string,
  chatId: string,
  requestAuthorityId: string,
  options?: { signal?: AbortSignal },
) => Promise<{ acknowledged: true; state: 'accepted' | 'already_acknowledged' }>
type GenerationStopImplementation = (
  generationId?: string,
  chatId?: string,
  requestAuthorityId?: string,
) => Promise<{ stopped: boolean; status: 'accepted' | 'too_late' | 'not_found' }>
let dispatchAcknowledgementImplementation: DispatchAcknowledgementImplementation = async () => ({
  acknowledged: true,
  state: 'accepted',
})
let generationStopImplementation: GenerationStopImplementation = async () => ({ stopped: true, status: 'accepted' })

function isLiveGenerationRequest(status: GenerationRequestStatus): boolean {
  return status === 'pending' || status === 'queued' || status === 'working'
}

function boundedGenerationHistory(values: readonly string[], next?: string | null): string[] {
  const result = next && !values.includes(next) ? [...values, next] : [...values]
  return result.length > 32 ? result.slice(result.length - 32) : result
}

const storeState = {
  messages: [] as Array<{ id: string }>,
  activeChatId: null as string | null,
  activeGenerationId: null as string | null,
  generationRequests: {} as Record<string, GenerationRequestAuthority>,
  agentRunProvisionalByKey: {} as Record<string, AgentRunPublicV2>,
  agentRunTerminalByTarget: {} as Record<string, AgentRunPublicV2>,
  isStreaming: false,
  regeneratingMessageId: null as string | null,
  streamingGenerationType: null as string | null,
  streamingSwipeId: null as number | null,
  activeProfileId: null as string | null,
  activePersonaId: null as string | null,
  activeCharacterId: null as string | null,
  activeChatMetadata: null as { temporary?: boolean } | null,
  isGroupChat: false,
  regenFeedback: { enabled: false, position: 'before', format: 'plain' },
  getActivePresetForGeneration: () => null,
  openModal: () => {},
  beginGenerationRequest: (chatId: string, intent: GenerationRequestIntent): GenerationRequestAuthority => {
    const current = storeState.generationRequests[chatId]
    current?.abortController?.abort(new DOMException('Superseded generation', 'AbortError'))
    const previousGenerationId = current?.generationId ?? null
    const next: GenerationRequestAuthority = {
      chatId,
      epoch: (current?.epoch ?? 0) + 1,
      requestAuthorityId: intent.requestAuthorityId === undefined ? crypto.randomUUID() : intent.requestAuthorityId,
      generationId: null,
      abortController: new AbortController(),
      status: 'pending',
      generationType: intent.generationType,
      targetMessageId: intent.targetMessageId ?? null,
      targetSwipeId: intent.targetSwipeId ?? null,
      retiredGenerationIds: boundedGenerationHistory(
        current?.retiredGenerationIds ?? [],
        isLiveGenerationRequest(current?.status ?? 'completed') ? previousGenerationId : null,
      ),
      terminalGenerationIds: boundedGenerationHistory(current?.terminalGenerationIds ?? [], previousGenerationId),
    }
    storeState.generationRequests = { ...storeState.generationRequests, [chatId]: next }
    return next
  },
  acceptGenerationRequest: (
    chatId: string,
    generationId: string,
    requestAuthorityId?: string,
    status: 'queued' | 'working' = 'queued',
  ): boolean => {
    const current = storeState.generationRequests[chatId]
    if (current) {
      if (!isLiveGenerationRequest(current.status)) return false
      if (current.requestAuthorityId !== null && current.requestAuthorityId !== (requestAuthorityId ?? null)) return false
      if (current.retiredGenerationIds.includes(generationId) || current.terminalGenerationIds.includes(generationId)) return false
      if (current.generationId && current.generationId !== generationId) return false
      storeState.generationRequests = {
        ...storeState.generationRequests,
        [chatId]: {
          ...current,
          generationId,
          status: current.status === 'working' ? 'working' : status,
        },
      }
      return true
    }
    storeState.generationRequests = {
      ...storeState.generationRequests,
      [chatId]: {
        chatId,
        epoch: 1,
        requestAuthorityId: requestAuthorityId ?? null,
        generationId,
        abortController: null,
        status,
        generationType: 'normal',
        targetMessageId: null,
        targetSwipeId: null,
        retiredGenerationIds: [],
        terminalGenerationIds: [],
      },
    }
    return true
  },
  settleGenerationRequest: (
    chatId: string,
    status: 'completed' | 'stopped' | 'error',
    generationId?: string | null,
    requestAuthorityId?: string,
  ): boolean => {
    const current = storeState.generationRequests[chatId]
    if (!current) return false
    if (current.requestAuthorityId !== null && current.requestAuthorityId !== (requestAuthorityId ?? null)) return false
    if (generationId && current.generationId && current.generationId !== generationId) return false
    if (generationId && current.retiredGenerationIds.includes(generationId)) return false
    const canonicalOverridesOptimisticStop = current.status === 'stopped'
      && status !== 'stopped'
      && !!generationId
      && (!current.generationId || current.generationId === generationId)
    if (!isLiveGenerationRequest(current.status) && !canonicalOverridesOptimisticStop) return false
    const terminalId = generationId ?? current.generationId
    storeState.generationRequests = {
      ...storeState.generationRequests,
      [chatId]: {
        ...current,
        generationId: terminalId,
        abortController: null,
        status,
        terminalGenerationIds: boundedGenerationHistory(current.terminalGenerationIds, terminalId),
      },
    }
    return true
  },
  stopGenerationRequest: (chatId: string): GenerationRequestAuthority | null => {
    const current = storeState.generationRequests[chatId]
    if (!current || !isLiveGenerationRequest(current.status)) return current ?? null
    current.abortController?.abort(new DOMException('Generation cancelled', 'AbortError'))
    const stopped: GenerationRequestAuthority = {
      ...current,
      abortController: null,
      status: 'stopped',
      terminalGenerationIds: boundedGenerationHistory(current.terminalGenerationIds, current.generationId),
    }
    storeState.generationRequests = { ...storeState.generationRequests, [chatId]: stopped }
    return stopped
  },
  beginStreaming: (messageId?: string, generationType?: string) => {
    storeState.isStreaming = true
    storeState.activeGenerationId = null
    storeState.regeneratingMessageId = messageId ?? null
    storeState.streamingGenerationType = generationType ?? null
  },
  endStreaming: () => {
    storeState.isStreaming = false
    storeState.activeGenerationId = null
    storeState.regeneratingMessageId = null
    storeState.streamingSwipeId = null
    storeState.streamingGenerationType = null
  },
  stopStreaming: () => {
    storeState.isStreaming = false
    storeState.activeGenerationId = null
    storeState.regeneratingMessageId = null
    storeState.streamingSwipeId = null
    storeState.streamingGenerationType = null
  },
  setStreamingError: (error: string) => {
    streamingErrors.push(error)
    storeState.isStreaming = false
    storeState.activeGenerationId = null
  },
  mpRoomId: null as string | null,
  mpIsHost: false,
  mpChatId: null as string | null,
  getStreamBuffers: () => ({ content: '', reasoning: '' }),
  setGenerationProviderMetadata: (metadata: { provider?: string | null; model?: string | null }) => {
    providerMetadataCalls.push(metadata)
    if (metadata.provider !== undefined) currentProvider = metadata.provider
    if (metadata.model !== undefined) currentModel = metadata.model
  },
  startStreaming: (generationId: string) => {
    streamStarts.push(generationId)
    storeState.activeGenerationId = generationId
    storeState.isStreaming = true
    currentProvider = null
    currentModel = null
  },
  setStreamingSwipeId: (swipeId: number | null) => {
    storeState.streamingSwipeId = swipeId
  },
}

function agentRunKey(run: AgentRunPublicV2): string {
  const target = run.target ? run.target.messageId + ':' + run.target.swipeId : 'pending'
  return run.chatId + ':' + run.turnId + ':' + run.generationType + ':' + target
}

function seedAgentRun(generationId: string, terminal = false): void {
  const target = { messageId: 'target-' + generationId, swipeId: 0 }
  const run = {
    version: 2,
    runId: 'run-' + generationId,
    turnId: 'turn-' + generationId,
    generationId,
    chatId: 'chat-a',
    generationType: 'swipe',
    target,
    workPhase: terminal ? 'TERMINAL' : 'WORK',
    workStatus: terminal ? 'terminal' : 'running',
    workOutcome: terminal ? 'completed' : null,
    recoveryEligible: false,
    recoveryAction: 'none',
    omissionCount: 0,
    inspectionAttemptId: 'inspection-' + generationId,
    reason: null,
    attemptLineage: {
      version: 1,
      attemptId: 'attempt-' + generationId,
      previousAttemptId: null,
      target: { chatId: 'chat-a', generationType: 'swipe', messageId: target.messageId, swipeId: target.swipeId },
      createdAt: 0,
    },
    revision: 1,
    sequence: 1,
    startedAt: 0,
    updatedAt: 0,
    activity: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    terminalHandoff: terminal
      ? { version: 2, committed: true, messageId: target.messageId, swipeId: target.swipeId, messageRevision: 1, swipeRevision: 1 }
      : undefined,
  } as AgentRunPublicV2
  if (terminal) storeState.agentRunTerminalByTarget['chat-a:' + target.messageId + ':' + target.swipeId] = run
  else storeState.agentRunProvisionalByKey[agentRunKey(run)] = run
}

function startedRequestAuthorityId(): string {
  const request = generationStarts[0]
  if (!request || typeof request !== 'object' || typeof (request as { request_authority_id?: unknown }).request_authority_id !== 'string') {
    throw new Error('generation request did not carry request_authority_id')
  }
  return (request as { request_authority_id: string }).request_authority_id
}

async function waitForGenerationAdmission(chatId: string): Promise<void> {
  await generationAdmission.promise
  const authority = storeState.generationRequests[chatId]
  if (generationStarts.length !== 1 || typeof authority?.requestAuthorityId !== 'string') {
    throw new Error('generation start did not retain exact request authority')
  }
}

function beginMockGeneration(path: string, request: unknown) {
  generationStartPaths.push(path)
  generationStarts.push(request)
  generationAdmission.resolve()
  return generationStart.promise.then((response) => {
    queueMicrotask(() => queueMicrotask(generationContinuation.resolve))
    return response
  })
}

function createControlledStopScheduler() {
  let now = 0
  let waitObserved = Promise.withResolvers<void>()
  const waits: Array<{ delayMs: number; resolve: () => void }> = []
  return {
    scheduler: {
      now: () => now,
      wait: (delayMs: number) => {
        const gate = Promise.withResolvers<void>()
        waits.push({ delayMs, resolve: gate.resolve })
        waitObserved.resolve()
        return gate.promise
      },
    },
    waitUntilScheduled: () => waitObserved.promise,
    advanceNext: () => {
      const next = waits.shift()
      if (!next) throw new Error('no Stop convergence wait is scheduled')
      now += next.delayMs
      waitObserved = Promise.withResolvers<void>()
      next.resolve()
    },
  }
}

mock.module('@/api/generate', () => ({
  generateApi: {
    getStatus: async () => generationStatusImplementation(),
    start: async (request: unknown) => beginMockGeneration('start', request),
    regenerate: async (request: unknown) => beginMockGeneration('regenerate', request),
    continueGeneration: async (request: unknown) => beginMockGeneration('continue', request),
    acknowledgeDispatch: async (
      generationId: string,
      chatId: string,
      requestAuthorityId: string,
      options?: { signal?: AbortSignal },
    ) => {
      dispatchAcknowledgements.push({ generationId, chatId, requestAuthorityId })
      dispatchAcknowledgementSignals.push(options?.signal)
      return dispatchAcknowledgementImplementation(generationId, chatId, requestAuthorityId, options)
    },
    stop: async (generationId?: string, chatId?: string, requestAuthorityId?: string) => {
      generationStops.push({ generationId, chatId, requestAuthorityId })
      return generationStopImplementation(generationId, chatId, requestAuthorityId)
    },
  },
}))

mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))
mock.module('@/api/chats', () => ({
  messagesApi: { swipe: async () => undefined },
  chatsApi: { listAgentActivityRuns: async () => activityRunsImplementation() },
}))

const mockedUseStore = Object.assign(
  <T>(selector: (state: typeof storeState) => T): T => selector(storeState),
  {
    getState: () => storeState,
    setState: (updates: Record<string, unknown>) => Object.assign(storeState, updates),
  },
)
mock.module('@/store', () => ({ useStore: mockedUseStore }))

// Dynamic import is intentional: the store mock must be registered before
// Bun evaluates the real production authority module and its dependencies.
const {
  acceptGenerationEnded,
  acceptGenerationStarted,
  beginGenerationRequest,
  captureGenerationRequest,
  consumeGenerationStopResult,
  invalidateGenerationRequest,
  isGenerationRequestCurrent,
  recoverPooledGeneration,
  startGenerationWithRecovery,
  resetGenerationRecoveryGuardsForTests,
  __generationRecoveryTesting,
} = await import('./generation-recovery')
const { ApiError } = await import('../api/client')
const { default: useSwipeAction, executeSwipe } = await import('../hooks/useSwipeAction')
const {
  acceptsClientGenerationAuthority,
  beginClientGenerationAuthority,
  stopClientGenerationAuthority,
} = await import('./generation-request-authority')

beforeEach(() => {
  resetGenerationRecoveryGuardsForTests()
  generationStatus = { active: false }
  generationStatusImplementation = async () => generationStatus
  activityRunsImplementation = async () => ({ runs: [] })
  providerMetadataCalls.length = 0
  streamStarts.length = 0
  generationStarts.length = 0
  generationStartPaths.length = 0
  dispatchAcknowledgements.length = 0
  dispatchAcknowledgementSignals.length = 0
  generationStops.length = 0
  streamingErrors.length = 0
  generationStart = Promise.withResolvers<{ generationId: string; mode?: 'response' | 'agentic' }>()
  generationAdmission = Promise.withResolvers<void>()
  generationContinuation = Promise.withResolvers<void>()
  dispatchAcknowledgementImplementation = async () => ({ acknowledged: true, state: 'accepted' })
  generationStopImplementation = async () => ({ stopped: true, status: 'accepted' })
  currentProvider = null
  currentModel = null
  Object.assign(storeState, {
    activeChatId: null,
    activeGenerationId: null,
    generationRequests: {},
    agentRunProvisionalByKey: {},
    agentRunTerminalByTarget: {},
    isStreaming: false,
    mpRoomId: null,
    mpIsHost: false,
    mpChatId: null,
    regeneratingMessageId: null,
    streamingGenerationType: null,
    streamingSwipeId: null,
  })
})


describe('generation start acknowledgement', () => {
  test('acknowledges accepted Agentic start, regenerate, and continue responses exactly once', async () => {
    for (const path of ['start', 'regenerate', 'continue'] as const) {
      resetGenerationRecoveryGuardsForTests()
      generationStarts.length = 0
      generationStartPaths.length = 0
      dispatchAcknowledgements.length = 0
      generationStart = Promise.withResolvers<{ generationId: string; mode?: 'response' | 'agentic' }>()
      generationAdmission = Promise.withResolvers<void>()
      const chatId = 'chat-' + path
      const generationId = 'generation-' + path
      storeState.activeChatId = chatId

      const starting = startGenerationWithRecovery(path, {
        chat_id: chatId,
        generation_type: path === 'start' ? 'normal' : path,
      })
      await waitForGenerationAdmission(chatId)
      const requestAuthorityId = startedRequestAuthorityId()
      generationStart.resolve({ generationId, mode: 'agentic' })

      expect(await starting).toEqual({ generationId, mode: 'agentic' })
      expect(generationStartPaths).toEqual([path])
      expect(dispatchAcknowledgements).toEqual([{
        generationId,
        chatId,
        requestAuthorityId,
      }])
    }
  })

  test('retries the identical ACK after an accepted response is lost', async () => {
    const chatId = 'chat-ack-response-lost'
    const generationId = 'generation-ack-response-lost'
    const lostResponse = new TypeError('ACK response lost')
    let accepted = false
    dispatchAcknowledgementImplementation = async () => {
      if (!accepted) {
        accepted = true
        throw lostResponse
      }
      return { acknowledged: true, state: 'already_acknowledged' }
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const authority = storeState.generationRequests[chatId]!
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })

    expect(await starting).toEqual({ generationId, mode: 'agentic' })
    expect(dispatchAcknowledgements).toEqual([
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
    ])
    expect(dispatchAcknowledgementSignals).toEqual([
      authority.abortController?.signal,
      authority.abortController?.signal,
    ])
    expect(generationStops).toEqual([])
  })

  test('awaits a canonical terminal after an accepted exact Stop before preserving the ACK failure', async () => {
    const chatId = 'chat-ack-persistent-loss'
    const generationId = 'generation-ack-persistent-loss'
    const transportFailure = new TypeError('ACK transport unavailable')
    const stopStarted = Promise.withResolvers<void>()
    const stopAnswer = Promise.withResolvers<{ stopped: boolean; status: 'accepted' }>()
    dispatchAcknowledgementImplementation = async () => { throw transportFailure }
    generationStopImplementation = async () => {
      stopStarted.resolve()
      return stopAnswer.promise
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })
    const observed = starting.then(
      () => ({ status: 'resolved' as const, error: undefined }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )

    await stopStarted.promise
    let surfaced = false
    void observed.then(() => { surfaced = true })
    await Promise.resolve()
    expect(surfaced).toBe(false)
    expect(dispatchAcknowledgements).toEqual([
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
    ])
    expect(generationStops).toEqual([{ generationId, chatId, requestAuthorityId }])
    expect(streamStarts).toEqual([])

    generationStatus = { active: false, generationId, requestAuthorityId, status: 'stopped' }
    stopAnswer.resolve({ stopped: true, status: 'accepted' })
    expect(await observed).toEqual({ status: 'rejected', error: transportFailure })
    expect(storeState.generationRequests[chatId]?.status).toBe('stopped')
  })

  test('retries the exact Stop when its accepted response is lost', async () => {
    const chatId = 'chat-stop-response-lost'
    const generationId = 'generation-stop-response-lost'
    const transportFailure = new TypeError('ACK transport unavailable')
    let stopAttempts = 0
    dispatchAcknowledgementImplementation = async () => { throw transportFailure }
    generationStopImplementation = async () => {
      stopAttempts += 1
      if (stopAttempts === 1) {
        generationStatus = { active: false, generationId, requestAuthorityId: startedRequestAuthorityId(), status: 'stopped' }
        throw new TypeError('Stop response lost')
      }
      return { stopped: true, status: 'accepted' }
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })

    await expect(starting).rejects.toBe(transportFailure)
    expect(generationStops).toEqual([
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
    ])
    expect(streamStarts).toEqual([])
  })

  test('retries when the first exact Stop request never reaches the server and the second is accepted', async () => {
    const chatId = 'chat-stop-first-request-fails'
    const generationId = 'generation-stop-first-request-fails'
    const transportFailure = new TypeError('ACK transport unavailable')
    let stopAttempts = 0
    dispatchAcknowledgementImplementation = async () => { throw transportFailure }
    generationStopImplementation = async () => {
      stopAttempts += 1
      if (stopAttempts === 1) throw new TypeError('Stop request failed before send')
      generationStatus = { active: false, generationId, requestAuthorityId: startedRequestAuthorityId(), status: 'stopped' }
      return { stopped: true, status: 'accepted' }
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })

    await expect(starting).rejects.toBe(transportFailure)
    expect(generationStops).toEqual([
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
    ])
    expect(streamStarts).toEqual([])
  })

  test('reissues exact Stop through persistent transport and status ambiguity until canonical terminal recovery', async () => {
    const chatId = 'chat-stop-persistent-recovery'
    const generationId = 'generation-stop-persistent-recovery'
    const transportFailure = new TypeError('ACK transport unavailable')
    const controlled = createControlledStopScheduler()
    __generationRecoveryTesting.configureStopConvergence({ scheduler: controlled.scheduler, deadlineMs: 200, pollMs: 100 })
    dispatchAcknowledgementImplementation = async () => { throw transportFailure }
    generationStopImplementation = async () => {
      if (generationStops.length < 3) throw new TypeError('Stop transport unavailable')
      return { stopped: true, status: 'accepted' }
    }
    generationStatusImplementation = async () => {
      if (generationStops.length < 3) throw new TypeError('status transport unavailable')
      return { active: false, generationId, requestAuthorityId: startedRequestAuthorityId(), status: 'stopped' }
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })
    await controlled.waitUntilScheduled()
    controlled.advanceNext()

    await expect(starting).rejects.toBe(transportFailure)
    expect(generationStops).toEqual([
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
      { generationId, chatId, requestAuthorityId },
    ])
    expect(streamStarts).toEqual([])
  })

  test('retains a recoverable pending-Stop authority when Stop and terminal recovery remain partitioned', async () => {
    const chatId = 'chat-stop-total-partition'
    const generationId = 'generation-stop-total-partition'
    const controlled = createControlledStopScheduler()
    __generationRecoveryTesting.configureStopConvergence({ scheduler: controlled.scheduler, deadlineMs: 200, pollMs: 100 })
    dispatchAcknowledgementImplementation = async () => { throw new TypeError('ACK transport unavailable') }
    generationStopImplementation = async () => { throw new TypeError('Stop transport unavailable') }
    generationStatusImplementation = async () => { throw new TypeError('status transport unavailable') }
    activityRunsImplementation = async () => { throw new TypeError('activity transport unavailable') }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })
    await controlled.waitUntilScheduled()
    controlled.advanceNext()
    await controlled.waitUntilScheduled()
    controlled.advanceNext()

    expect(await starting).toEqual({ generationId, mode: 'agentic' })
    expect(generationStops).toHaveLength(3)
    expect(generationStops.every((stop) => stop.generationId === generationId
      && stop.chatId === chatId
      && stop.requestAuthorityId === requestAuthorityId)).toBe(true)
    expect(storeState.generationRequests[chatId]).toMatchObject({
      generationId,
      requestAuthorityId,
      status: 'queued',
      stopPending: true,
    })
    expect(streamStarts).toEqual([])
  })

  test('canonical completed winner resolves success without duplicate generation or failure', async () => {
    const chatId = 'chat-stop-completed-winner'
    const generationId = 'generation-stop-completed-winner'
    dispatchAcknowledgementImplementation = async () => { throw new TypeError('ACK transport unavailable') }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStatus = { active: false, generationId, requestAuthorityId, status: 'completed' }
    generationStart.resolve({ generationId, mode: 'agentic' })

    expect(await starting).toEqual({ generationId, mode: 'agentic' })
    expect(generationStarts).toHaveLength(1)
    expect(dispatchAcknowledgements).toHaveLength(2)
    expect(generationStops).toEqual([{ generationId, chatId, requestAuthorityId }])
    expect(storeState.generationRequests[chatId]?.status).toBe('completed')
    expect(streamingErrors).toEqual([])
  })

  test('does not retry a semantic 4xx Stop when canonical completion wins', async () => {
    const chatId = 'chat-stop-semantic-rejection'
    const generationId = 'generation-stop-semantic-rejection'
    dispatchAcknowledgementImplementation = async () => { throw new TypeError('ACK transport unavailable') }
    generationStopImplementation = async () => {
      throw new ApiError(409, 'Conflict', { stopped: false, status: 'too_late' })
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStatus = { active: false, generationId, requestAuthorityId, status: 'completed' }
    generationStart.resolve({ generationId, mode: 'agentic' })

    expect(await starting).toEqual({ generationId, mode: 'agentic' })
    expect(generationStops).toEqual([{ generationId, chatId, requestAuthorityId }])
    expect(storeState.generationRequests[chatId]?.status).toBe('completed')
    expect(streamingErrors).toEqual([])
  })

  test('user abort during ACK skips retry and awaits exact Stop', async () => {
    const chatId = 'chat-ack-user-abort'
    const generationId = 'generation-ack-user-abort'
    const external = new AbortController()
    const acknowledgementStarted = Promise.withResolvers<AbortSignal>()
    dispatchAcknowledgementImplementation = async (_generationId, _chatId, _requestAuthorityId, options) => {
      const signal = options?.signal
      if (!signal) throw new Error('ACK request signal missing')
      acknowledgementStarted.resolve(signal)
      return new Promise((_, reject) => {
        const rejectAbort = () => reject(signal.reason)
        if (signal.aborted) rejectAbort()
        else signal.addEventListener('abort', rejectAbort, { once: true })
      })
    }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery(
      'start',
      { chat_id: chatId, generation_type: 'normal' },
      { signal: external.signal },
    )
    await waitForGenerationAdmission(chatId)
    const authority = storeState.generationRequests[chatId]!
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })
    generationStatus = { active: false, generationId, requestAuthorityId, status: 'stopped' }
    expect(await acknowledgementStarted.promise).toBe(authority.abortController?.signal)

    const abortReason = new DOMException('Generation cancelled', 'AbortError')
    external.abort(abortReason)
    await expect(starting).rejects.toBe(abortReason)
    expect(dispatchAcknowledgements).toEqual([{ generationId, chatId, requestAuthorityId }])
    expect(generationStops).toEqual([{ generationId, chatId, requestAuthorityId }])
  })

  test('does not retry or Stop after a semantic 4xx ACK rejection', async () => {
    const chatId = 'chat-ack-rejected'
    const generationId = 'generation-ack-rejected'
    const rejection = new ApiError(409, 'Conflict', { acknowledged: false, state: 'rejected' })
    dispatchAcknowledgementImplementation = async () => { throw rejection }
    storeState.activeChatId = chatId

    const starting = startGenerationWithRecovery('start', { chat_id: chatId, generation_type: 'normal' })
    await waitForGenerationAdmission(chatId)
    const requestAuthorityId = startedRequestAuthorityId()
    generationStart.resolve({ generationId, mode: 'agentic' })

    await expect(starting).rejects.toBe(rejection)
    expect(dispatchAcknowledgements).toEqual([{ generationId, chatId, requestAuthorityId }])
    expect(generationStops).toEqual([])
  })
})
describe('generation terminal Stop consumption', () => {
  test('canonical standalone terminal Stop settles the exact request as stopped', () => {
    const chatId = 'chat-terminal-stop-payload'
    const generationId = 'generation-terminal-stop-payload'
    const requestAuthorityId = 'authority-terminal-stop-payload'
    beginGenerationRequest(chatId, { generationType: 'normal', requestAuthorityId })
    expect(storeState.acceptGenerationRequest(chatId, generationId, requestAuthorityId, 'working')).toBe(true)
    storeState.activeChatId = chatId
    storeState.activeGenerationId = generationId
    storeState.isStreaming = true

    expect(consumeGenerationStopResult(chatId, {
      version: 2,
      status: 'terminal',
      turnId: generationId,
      revision: 2,
      target: { chatId, generationType: 'normal', messageId: null, swipeId: null },
      workPhase: 'TERMINAL',
      workStatus: 'terminal',
      workOutcome: 'stopped',
      reason: 'stopped',
      recoveryEligible: false,
      recoveryAction: 'none',
      omissionCount: 0,
      inspectionAttemptId: generationId,
    }, generationId, 'Generation failed', requestAuthorityId)).toBe('terminal')
    expect(storeState.generationRequests[chatId]).toMatchObject({
      generationId,
      requestAuthorityId,
      status: 'stopped',
    })
    expect(storeState.isStreaming).toBe(false)
    expect(streamingErrors).toEqual([])
  })
})

describe('generation authority invalidation', () => {
  test('a late G1 invalidation retires only G1 after G2 starts', () => {
    const g1AuthorityId = 'authority-g1'
    beginGenerationRequest('chat-a', { generationType: 'normal', requestAuthorityId: g1AuthorityId })
    seedAgentRun('G1')
    expect(acceptGenerationStarted('chat-a', 'G1', g1AuthorityId)).toBe(true)

    const g2AuthorityId = 'authority-g2'
    const g2Epoch = beginGenerationRequest('chat-a', { generationType: 'normal', requestAuthorityId: g2AuthorityId })
    seedAgentRun('G2')
    expect(acceptGenerationStarted('chat-a', 'G2', g2AuthorityId)).toBe(true)

    expect(invalidateGenerationRequest('chat-a', 'G1')).toBe(g2Epoch)
    expect(invalidateGenerationRequest('chat-a', 'G1')).toBe(g2Epoch)

    const g2Request = captureGenerationRequest('chat-a')
    expect(g2Request).toMatchObject({ epoch: g2Epoch, requestAuthorityId: g2AuthorityId, generationId: 'G2' })
    expect(isGenerationRequestCurrent(g2Request, 'G2', true)).toBe(true)
    expect(acceptGenerationStarted('chat-a', 'G2', g2AuthorityId)).toBe(true)
    expect(acceptGenerationStarted('chat-a', 'G1', g1AuthorityId)).toBe(false)
  })

  test('settling the current generation is idempotent and preserves its authority', () => {
    // This lifecycle uses the legacy null authority because the production
    // invalidation boundary settles without passing an authority ID.
    const requestAuthorityId = null
    const epoch = beginGenerationRequest('chat-a', { generationType: 'normal', requestAuthorityId })
    seedAgentRun('G2')
    expect(acceptGenerationStarted('chat-a', 'G2')).toBe(true)

    expect(invalidateGenerationRequest('chat-a', 'G2')).toBe(epoch)
    const stopped = storeState.generationRequests['chat-a']
    expect(stopped).toMatchObject({
      chatId: 'chat-a',
      epoch,
      requestAuthorityId,
      generationId: 'G2',
      status: 'stopped',
    })
    expect(stopped.terminalGenerationIds).toContain('G2')

    // The canonical completion boundary may replace an optimistic Stop.
    expect(acceptGenerationEnded('chat-a', 'G2', 'completed')).toBe(true)
    const completed = storeState.generationRequests['chat-a']
    expect(completed).toMatchObject({
      chatId: 'chat-a',
      epoch,
      requestAuthorityId,
      generationId: 'G2',
      status: 'completed',
    })
    expect(completed.terminalGenerationIds).toContain('G2')

    // A non-null mismatched authority cannot settle a live lifecycle.
    const guardedAuthorityId = 'authority-guarded'
    const guardedEpoch = beginGenerationRequest('chat-b', {
      generationType: 'normal',
      requestAuthorityId: guardedAuthorityId,
    })
    expect(acceptGenerationEnded('chat-b', 'G-guarded', 'completed', 'mismatched-authority')).toBe(false)
    expect(storeState.generationRequests['chat-b']).toMatchObject({
      epoch: guardedEpoch,
      requestAuthorityId: guardedAuthorityId,
      generationId: null,
      status: 'pending',
      terminalGenerationIds: [],
    })
    expect(storeState.generationRequests['chat-a']).toMatchObject({ status: 'completed', requestAuthorityId })
    expect(invalidateGenerationRequest('chat-a', 'G2')).toBe(epoch)
    expect(isGenerationRequestCurrent({ chatId: 'chat-a', epoch, requestAuthorityId: 'stale-authority', generationId: 'G2' }, 'G2')).toBe(false)
  })

  test('executeSwipe rejects WS-before-HTTP resurrection after same-chat Stop', async () => {
    storeState.activeChatId = 'chat-a'
    const message = { id: 'assistant-1', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
    storeState.messages = [message]
    const initialAuthorityId = beginClientGenerationAuthority('chat-a')
    const swipe = executeSwipe(message as never, 'chat-a', 'right')
    await waitForGenerationAdmission('chat-a')
    expect(generationStarts).toHaveLength(1)
    const requestAuthorityId = startedRequestAuthorityId()
    expect(requestAuthorityId).not.toBe(initialAuthorityId)
    expect(acceptsClientGenerationAuthority('chat-a', initialAuthorityId)).toBe(false)
    expect(acceptsClientGenerationAuthority('chat-a', requestAuthorityId)).toBe(true)
    seedAgentRun('G-before-http')
    expect(acceptGenerationStarted('chat-a', 'G-before-http', requestAuthorityId)).toBe(true)

    expect(stopClientGenerationAuthority('chat-a')).toBe(requestAuthorityId)
    invalidateGenerationRequest('chat-a', 'G-before-http')
    generationStart.resolve({ generationId: 'G-before-http' })
    await swipe

    expect(storeState.activeChatId).toBe('chat-a')
    expect(streamStarts).toEqual([])
    expect(acceptsClientGenerationAuthority('chat-a', requestAuthorityId)).toBe(false)
    expect(acceptGenerationStarted('chat-a', 'G-before-http', requestAuthorityId)).toBe(false)
  })

  test('the real useSwipeAction hook rejects the same Stop ordering', async () => {
    const { JSDOM } = await import('jsdom')
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = React
    const dom = new JSDOM('<div id="root"></div>')
    dom.window.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0)) as unknown as typeof dom.window.requestAnimationFrame
    dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof dom.window.cancelAnimationFrame
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
    const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const previousReactActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
    let root: ReturnType<typeof createRoot> | null = null

    try {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator })
      storeState.activeChatId = 'chat-a'
      const message = { id: 'assistant-hook', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
      storeState.messages = [message]
      let actions: ReturnType<typeof useSwipeAction> | null = null
      const Harness = () => {
        actions = useSwipeAction(message as never, 'chat-a')
        return null
      }
      root = createRoot(dom.window.document.getElementById('root')!)
      await act(async () => { root!.render(React.createElement(Harness)) })
      const initialAuthorityId = beginClientGenerationAuthority('chat-a')
      actions!.handleRegenerate()
      await waitForGenerationAdmission('chat-a')
      const requestAuthorityId = startedRequestAuthorityId()
      expect(requestAuthorityId).not.toBe(initialAuthorityId)
      expect(acceptsClientGenerationAuthority('chat-a', initialAuthorityId)).toBe(false)
      expect(acceptsClientGenerationAuthority('chat-a', requestAuthorityId)).toBe(true)
      seedAgentRun('G-hook-before-http')
      expect(acceptGenerationStarted('chat-a', 'G-hook-before-http', requestAuthorityId)).toBe(true)
      expect(stopClientGenerationAuthority('chat-a')).toBe(requestAuthorityId)
      invalidateGenerationRequest('chat-a', 'G-hook-before-http')
      generationStart.resolve({ generationId: 'G-hook-before-http' })
      await generationContinuation.promise
      expect(streamStarts).toEqual([])
      expect(acceptsClientGenerationAuthority('chat-a', requestAuthorityId)).toBe(false)
    } finally {
      try {
        if (root) await act(async () => { root!.unmount() })
      } finally {
        dom.window.close()
        Object.assign(globalThis, previousGlobals)
        if (previousReactActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
        else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment
      }
    }
  })

  test('navigation preserves a deferred swipe and pooled recovery projects it once', async () => {
    storeState.activeChatId = 'chat-a'
    const message = { id: 'assistant-nav', is_user: false, swipe_id: 0, swipes: ['first'], extra: {} }
    storeState.messages = [message]
    const swipe = executeSwipe(message as never, 'chat-a', 'right')
    await waitForGenerationAdmission('chat-a')
    expect(generationStarts).toHaveLength(1)
    const requestAuthorityId = startedRequestAuthorityId()
    expect(acceptsClientGenerationAuthority('chat-a', requestAuthorityId)).toBe(true)
    seedAgentRun('G-background')
    storeState.activeChatId = 'chat-b'
    storeState.isStreaming = false
    generationStart.resolve({ generationId: 'G-background' })
    await swipe
    expect(acceptGenerationStarted('chat-a', 'G-background', requestAuthorityId)).toBe(true)
    expect(streamStarts).toEqual([])

    storeState.activeChatId = 'chat-a'
    storeState.activeGenerationId = null
    generationStatus = {
      active: true,
      generationId: 'G-background',
      status: 'streaming',
      requestAuthorityId,
    }
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(streamStarts).toEqual(['G-background'])
  })
})
describe('generation status provider identity', () => {
  test('projects the exact provider and model from a current active snapshot', async () => {
    storeState.activeChatId = 'chat-a'
    const requestAuthorityId = 'authority-status'
    beginGenerationRequest('chat-a', { generationType: 'swipe', requestAuthorityId })
    seedAgentRun('G-status')
    generationStatus = {
      active: true,
      generationId: 'G-status',
      status: 'assembling',
      requestAuthorityId,
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }

    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(providerMetadataCalls).toEqual([{
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }])
    expect(streamStarts).toEqual(['G-status'])
    expect(currentProvider).toBe('Deepseek')
    expect(currentModel).toBe('deepseek-v4-flash')
  })

  test('clears an absent provider without inferring it from the model', async () => {
    storeState.activeChatId = 'chat-a'
    const requestAuthorityId = 'authority-provider-absent'
    beginGenerationRequest('chat-a', { generationType: 'swipe', requestAuthorityId })
    seedAgentRun('G-provider-absent')
    generationStatus = {
      active: true,
      generationId: 'G-provider-absent',
      status: 'assembling',
      requestAuthorityId,
      model: 'deepseek-v4-flash',
    }

    expect(await recoverPooledGeneration('chat-a')).toBe('applied')
    expect(providerMetadataCalls).toEqual([{
      provider: null,
      model: 'deepseek-v4-flash',
    }])
    expect(currentProvider).toBeNull()
    expect(currentModel).toBe('deepseek-v4-flash')
  })

  test('does not overwrite identity for inactive or unidentified snapshots', async () => {
    storeState.activeChatId = 'chat-a'
    currentProvider = 'existing-provider'
    currentModel = 'existing-model'
    const requestAuthorityId = 'authority-terminal'
    storeState.beginGenerationRequest('chat-a', {
      generationType: 'normal',
      requestAuthorityId,
    })
    seedAgentRun('G-terminal', true)
    expect(acceptGenerationStarted('chat-a', 'G-terminal', requestAuthorityId)).toBe(true)
    generationStatus = {
      active: false,
      generationId: 'G-terminal',
      status: 'completed',
      requestAuthorityId,
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }
    expect(await recoverPooledGeneration('chat-a')).toBe('applied')

    generationStatus = {
      active: true,
      status: 'assembling',
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
    }
    expect(await recoverPooledGeneration('chat-a')).toBe('stale')
    expect(providerMetadataCalls).toEqual([])
    expect(currentProvider).toBe('existing-provider')
    expect(currentModel).toBe('existing-model')
  })
})
