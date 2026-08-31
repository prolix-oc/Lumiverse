import { generateApi } from '@/api/generate'
import type { GenerateRequest, GenerateResponse, GenerationRequestOptions, GenerationStatusResponse, GenerationStopResult } from '@/api/generate'
import type { AgentRunStopResultV2 } from '@/types/agent-runs'
import { messagesApi, chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import type { GenerationRequestAuthority } from '@/types/store'
import { yieldToBrowser } from '@/lib/spindle/browser-scheduler'
import { settleGenerationRequestFromExactTerminalRun } from '@/store/slices/agent-runs'
import { ApiError, type RequestOptions } from '@/api/client'

export interface GenerationRequestEpoch {
  chatId: string
  epoch: number
  requestAuthorityId: string | null
  generationId: string | null
}

export interface GenerationRequestIntent {
  generationType?: string
  targetMessageId?: string | null
  targetSwipeId?: number | null
  requestAuthorityId?: string | null
}

function isLiveRequest(authority: GenerationRequestAuthority | undefined): authority is GenerationRequestAuthority {
  return authority?.status === 'pending' || authority?.status === 'queued' || authority?.status === 'working'
}

/** Publish the sole reactive per-chat request authority synchronously. */
export function beginGenerationRequest(
  chatId: string,
  intentOrPrevious: GenerationRequestIntent | string = {},
): number {
  const intent = typeof intentOrPrevious === 'string' ? {} : intentOrPrevious
  const authority = useStore.getState().beginGenerationRequest(chatId, {
    generationType: intent.generationType ?? 'normal',
    targetMessageId: intent.targetMessageId,
    targetSwipeId: intent.targetSwipeId,
    requestAuthorityId: intent.requestAuthorityId,
  })
  return authority.epoch
}

export function invalidateGenerationRequest(chatId: string, generationId?: string | null): number {
  const state = useStore.getState()
  const current = state.generationRequests[chatId]
  if (!current) return 0
  if (generationId && current.generationId && current.generationId !== generationId) return current.epoch
  state.settleGenerationRequest(chatId, 'stopped', generationId)
  return current.epoch
}

export function acceptGenerationStarted(
  chatId: string,
  generationId: string,
  requestAuthorityId?: string,
  status: 'queued' | 'working' = 'queued',
): boolean {
  if (!chatId || !generationId) return false
  const state = useStore.getState()
  const accepted = state.acceptGenerationRequest(
    chatId,
    generationId,
    requestAuthorityId,
    status,
  )
  if (!accepted) return false
  // A terminal Agent Run can win the WS race before the HTTP start response
  // binds its generation ID to the live request. Settle only after that exact
  // response binding; nonmatching and superseding requests remain untouched.
  settleGenerationRequestFromExactTerminalRun(useStore.getState(), chatId, generationId)
  return true
}
export function acceptGenerationEnded(
  chatId: string,
  generationId: string,
  status: 'completed' | 'stopped' | 'error' = 'completed',
  requestAuthorityId?: string,
): boolean {
  if (!chatId || !generationId) return false
  return useStore.getState().settleGenerationRequest(
    chatId,
    status,
    generationId,
    requestAuthorityId,
  )
}

export type GenerationStopWireResult = GenerationStopResult | AgentRunStopResultV2

/**
 * Settle visible request/stream state only after the Stop owner answers.
 * A repaired terminal run is canonical and may replace an earlier optimistic
 * stopped request with its exact completed/failed outcome.
 */
export function consumeGenerationStopResult(
  chatId: string,
  result: GenerationStopWireResult,
  knownGenerationId?: string,
  failureMessage = 'Generation failed',
  knownRequestAuthorityId?: string | null,
): 'accepted' | 'too_late' | 'terminal' {
  let state = useStore.getState()
  let current = state.generationRequests[chatId]
  const expectedGenerationId = result.status === 'terminal' && 'terminal' in result
    ? result.terminal.generationId
    : knownGenerationId
  const targetsCurrentRequest = !current || (
    (knownRequestAuthorityId === undefined || current.requestAuthorityId === knownRequestAuthorityId)
    && (!expectedGenerationId || !current.generationId || current.generationId === expectedGenerationId)
  )
  if (result.status === 'accepted') {
    if (targetsCurrentRequest && (!current || isLiveRequest(current))) {
      state.stopGenerationRequest(chatId)
      state.stopStreaming()
    }
    return 'accepted'
  }
  if (result.status === 'terminal') {
    if (!targetsCurrentRequest) return 'terminal'
    const terminal = 'terminal' in result ? result.terminal : result
    const generationId = 'terminal' in result ? result.terminal.generationId : knownGenerationId
    const terminalStatus = terminal.workOutcome === 'stopped'
      ? 'stopped'
      : terminal.workOutcome === 'completed'
        ? 'completed'
        : 'error'
    if (!current && generationId) {
      state.acceptGenerationRequest(chatId, generationId, knownRequestAuthorityId ?? undefined, 'working')
      state = useStore.getState()
      current = state.generationRequests[chatId]
    }
    const settled = state.settleGenerationRequest(
      chatId,
      terminalStatus,
      generationId,
      knownRequestAuthorityId ?? current?.requestAuthorityId ?? undefined,
    )
    if (!settled) return 'terminal'
    if (terminalStatus === 'error') state.setStreamingError(failureMessage)
    else if (terminalStatus === 'stopped') state.stopStreaming()
    else state.endStreaming()
    return 'terminal'
  }
  if (result.status === 'not_found') return 'terminal'
  return 'too_late'
}
export function captureGenerationRequest(
  chatId: string,
  observedGenerationId?: string | null,
): GenerationRequestEpoch {
  let authority = useStore.getState().generationRequests[chatId]
  if (observedGenerationId && !authority) {
    useStore.getState().acceptGenerationRequest(chatId, observedGenerationId)
    authority = useStore.getState().generationRequests[chatId]
  }
  return {
    chatId,
    epoch: authority?.epoch ?? 0,
    requestAuthorityId: authority?.requestAuthorityId ?? null,
    generationId: observedGenerationId ?? authority?.generationId ?? null,
  }
}

export function isGenerationRequestCurrent(
  request: GenerationRequestEpoch,
  generationId?: string | null,
  active = false,
): boolean {
  const authority = useStore.getState().generationRequests[request.chatId]
  if (!authority || authority.epoch !== request.epoch) return false
  if (authority.requestAuthorityId !== request.requestAuthorityId) return false
  if (generationId && request.generationId && generationId !== request.generationId) return false
  if (generationId && authority.retiredGenerationIds.includes(generationId)) return false
  if (active && !isLiveRequest(authority)) return false
  if (active && generationId && authority.generationId && authority.generationId !== generationId) return false
  return true
}

export function isGenerationRequestCurrentForChat(
  request: GenerationRequestEpoch,
  generationId?: string | null,
  active = false,
): boolean {
  return useStore.getState().activeChatId === request.chatId
    && isGenerationRequestCurrent(request, generationId, active)
}

export type RecoveredGenerationPath = 'start' | 'regenerate' | 'continue'

class DispatchAcknowledgementRejectedError extends Error {}

const STOP_CONVERGENCE_DEADLINE_MS = 30_000
const STOP_CONVERGENCE_POLL_MS = 250
const STOP_CONVERGENCE_REQUEST_TIMEOUT_MS = 5_000

export interface GenerationStopConvergenceScheduler {
  now(): number
  wait(delayMs: number): Promise<void>
}

const SYSTEM_STOP_CONVERGENCE_SCHEDULER: GenerationStopConvergenceScheduler = {
  now: () => Date.now(),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}

let stopConvergenceScheduler = SYSTEM_STOP_CONVERGENCE_SCHEDULER
let stopConvergenceDeadlineMs = STOP_CONVERGENCE_DEADLINE_MS
let stopConvergencePollMs = STOP_CONVERGENCE_POLL_MS

export const __generationRecoveryTesting = {
  configureStopConvergence(input?: {
    scheduler?: GenerationStopConvergenceScheduler
    deadlineMs?: number
    pollMs?: number
  }): void {
    stopConvergenceScheduler = input?.scheduler ?? SYSTEM_STOP_CONVERGENCE_SCHEDULER
    stopConvergenceDeadlineMs = input?.deadlineMs ?? STOP_CONVERGENCE_DEADLINE_MS
    stopConvergencePollMs = input?.pollMs ?? STOP_CONVERGENCE_POLL_MS
  },
}

function isSemanticHttpRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

function isSemanticDispatchAcknowledgementRejection(error: unknown): boolean {
  return error instanceof DispatchAcknowledgementRejectedError || isSemanticHttpRejection(error)
}

function markGenerationStopPending(chatId: string, generationId: string, requestAuthorityId: string): void {
  const state = useStore.getState()
  const current = state.generationRequests[chatId]
  if (!current
    || current.generationId !== generationId
    || current.requestAuthorityId !== requestAuthorityId
    || !isLiveRequest(current)) return
  useStore.setState({
    generationRequests: {
      ...state.generationRequests,
      [chatId]: { ...current, stopPending: true },
    },
  })
}

type CanonicalStopConvergenceOutcome = 'stopped_or_error' | 'completed' | 'pending'

function terminalRequestOutcome(status: 'completed' | 'stopped' | 'error'): Exclude<CanonicalStopConvergenceOutcome, 'pending'> {
  return status === 'completed' ? 'completed' : 'stopped_or_error'
}

function settleTerminalGenerationStatus(
  chatId: string,
  generationId: string,
  requestAuthorityId: string,
  status: GenerationStatusResponse,
): Exclude<CanonicalStopConvergenceOutcome, 'pending'> | null {
  if (status.active
    || status.generationId !== generationId
    || status.requestAuthorityId !== requestAuthorityId
    || (status.status !== 'completed' && status.status !== 'stopped' && status.status !== 'error')) return null
  const state = useStore.getState()
  const settled = state.settleGenerationRequest(
    chatId,
    status.status,
    generationId,
    requestAuthorityId,
  )
  if (settled) {
    if (status.status === 'completed') state.endStreaming()
    else if (status.status === 'stopped') state.stopStreaming()
    else state.setStreamingError(status.error || 'Generation failed')
  }
  return terminalRequestOutcome(status.status)
}

async function observeCanonicalGenerationTerminal(
  chatId: string,
  generationId: string,
  requestAuthorityId: string,
  options: RequestOptions,
): Promise<Exclude<CanonicalStopConvergenceOutcome, 'pending'> | null> {
  try {
    const status = await generateApi.getStatus(chatId, undefined, options)
    const outcome = settleTerminalGenerationStatus(chatId, generationId, requestAuthorityId, status)
    if (outcome) return outcome
  } catch { /* status transport remains ambiguous */ }

  try {
    await recoverAgentActivityRuns(chatId, options)
  } catch { /* terminal activity recovery remains ambiguous */ }
  const state = useStore.getState()
  settleGenerationRequestFromExactTerminalRun(state, chatId, generationId)
  const current = useStore.getState().generationRequests[chatId]
  if (current?.generationId !== generationId || current.requestAuthorityId !== requestAuthorityId) return null
  if (current.status !== 'completed' && current.status !== 'stopped' && current.status !== 'error') return null
  return terminalRequestOutcome(current.status)
}

type ExactStopAttempt = 'stopped_or_error' | 'completed' | 'semantic' | 'ambiguous'


async function attemptExactGenerationStop(
  response: GenerateResponse,
  chatId: string,
  requestAuthorityId: string,
  options: RequestOptions,
): Promise<ExactStopAttempt> {
  try {
    const result = await generateApi.stop(response.generationId, chatId, requestAuthorityId, options)
    if (result.status === 'terminal') {
      if (result.terminal.generationId !== response.generationId) return 'semantic'
      consumeGenerationStopResult(chatId, result, response.generationId, 'Generation failed', requestAuthorityId)
      return result.terminal.workOutcome === 'completed' ? 'completed' : 'stopped_or_error'
    }
    return 'semantic'
  } catch (error) {
    return isSemanticHttpRejection(error) ? 'semantic' : 'ambiguous'
  }
}

async function convergeAmbiguousDispatchStop(
  response: GenerateResponse,
  chatId: string,
  requestAuthorityId: string,
): Promise<CanonicalStopConvergenceOutcome> {
  const deadline = stopConvergenceScheduler.now() + Math.max(0, stopConvergenceDeadlineMs)
  let mayReissueStop = true

  for (let attempt = 0; attempt < 2 && mayReissueStop; attempt += 1) {
    const remaining = Math.max(1, deadline - stopConvergenceScheduler.now())
    const outcome = await attemptExactGenerationStop(response, chatId, requestAuthorityId, {
      timeout: Math.min(STOP_CONVERGENCE_REQUEST_TIMEOUT_MS, remaining),
    })
    if (outcome === 'completed' || outcome === 'stopped_or_error') return outcome
    if (outcome === 'semantic') mayReissueStop = false
  }

  while (true) {
    const remaining = deadline - stopConvergenceScheduler.now()
    const requestOptions = { timeout: Math.max(1, Math.min(STOP_CONVERGENCE_REQUEST_TIMEOUT_MS, remaining)) }
    const observed = await observeCanonicalGenerationTerminal(chatId, response.generationId, requestAuthorityId, requestOptions)
    if (observed) return observed
    if (remaining <= 0) break
    await stopConvergenceScheduler.wait(Math.min(stopConvergencePollMs, remaining))
    const postWaitRemaining = deadline - stopConvergenceScheduler.now()
    if (mayReissueStop && postWaitRemaining > 0) {
      const outcome = await attemptExactGenerationStop(response, chatId, requestAuthorityId, {
        timeout: Math.min(STOP_CONVERGENCE_REQUEST_TIMEOUT_MS, postWaitRemaining),
      })
      if (outcome === 'completed' || outcome === 'stopped_or_error') return outcome
      if (outcome === 'semantic') mayReissueStop = false
    }
  }

  markGenerationStopPending(chatId, response.generationId, requestAuthorityId)
  return 'pending'
}

async function acknowledgeDispatchWithRecovery(
  response: GenerateResponse,
  chatId: string,
  requestAuthorityId: string,
  requestOptions: GenerationRequestOptions,
): Promise<void> {
  let ambiguousFailure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const acknowledgement = await generateApi.acknowledgeDispatch(
        response.generationId,
        chatId,
        requestAuthorityId,
        requestOptions,
      )
      if (acknowledgement.acknowledged !== true) {
        throw new DispatchAcknowledgementRejectedError('Dispatch acknowledgement rejected')
      }
      return
    } catch (error) {
      if (isSemanticDispatchAcknowledgementRejection(error)) throw error
      ambiguousFailure = error
      if (requestOptions.signal?.aborted || attempt === 1) break
    }
  }

  const convergence = await convergeAmbiguousDispatchStop(response, chatId, requestAuthorityId)
  if (convergence === 'stopped_or_error') throw ambiguousFailure
}

/**
 * Start a UI-owned generation through the store authority. If the caller
 * already published its request before an earlier write, that exact authority
 * is carried through runtime resolution, HTTP admission, Stop, and WS events.
 */
export async function startGenerationWithRecovery(
  path: RecoveredGenerationPath,
  request: GenerateRequest,
  options: GenerationRequestOptions = {},
): Promise<GenerateResponse> {
  const initial = useStore.getState()
  if (initial.activeChatId !== request.chat_id) {
    throw new DOMException('Generation cancelled', 'AbortError')
  }

  const existing = initial.generationRequests[request.chat_id]
  const authority = isLiveRequest(existing)
    && request.request_authority_id !== undefined
    && existing.requestAuthorityId === request.request_authority_id
    ? existing
    : initial.beginGenerationRequest(request.chat_id, {
        generationType: request.generation_type ?? 'normal',
        targetMessageId: request.message_id ?? null,
        targetSwipeId: request.swipe_id ?? null,
        requestAuthorityId: request.request_authority_id,
      })
  const generationRequest = captureGenerationRequest(request.chat_id)
  const admittedRequest: GenerateRequest = {
    ...request,
    request_authority_id: authority.requestAuthorityId ?? undefined,
  }
  const controller = authority.abortController
  if (!controller) throw new DOMException('Generation cancelled', 'AbortError')
  const onExternalAbort = () => controller.abort(
    options.signal?.reason ?? new DOMException('Generation cancelled', 'AbortError'),
  )
  if (options.signal?.aborted) onExternalAbort()
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const requestOptions: GenerationRequestOptions = { ...options, signal: controller.signal }

  try {
    // The request authority is the human's Stop surface before either runtime
    // preflight or backend admission has an ID. Give React one shared paint
    // boundary to commit it, then re-check the same authority and signal.
    await yieldToBrowser({ when: 'paint' })
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Generation cancelled', 'AbortError')
    }
    if (!isGenerationRequestCurrent(generationRequest, undefined, true)) {
      throw new DOMException('Generation cancelled', 'AbortError')
    }
    const response = path === 'regenerate'
      ? await generateApi.regenerate(admittedRequest, requestOptions)
      : path === 'continue'
        ? await generateApi.continueGeneration(admittedRequest, requestOptions)
        : await generateApi.start(admittedRequest, requestOptions)

    if (
      !isGenerationRequestCurrent(generationRequest, response.generationId, true)
      || !acceptGenerationStarted(
        request.chat_id,
        response.generationId,
        authority.requestAuthorityId ?? undefined,
      )
    ) {
      invalidateGenerationRequest(request.chat_id, response.generationId)
      throw new DOMException('Generation cancelled', 'AbortError')
    }
    if (response.mode === 'agentic') {
      const requestAuthorityId = authority.requestAuthorityId
      if (typeof requestAuthorityId !== 'string') {
        throw new DOMException('Generation cancelled', 'AbortError')
      }
      await acknowledgeDispatchWithRecovery(
        response,
        request.chat_id,
        requestAuthorityId,
        requestOptions,
      )
    }
    return response
  } catch (error) {
    const status = error instanceof DOMException && error.name === 'AbortError'
      ? 'stopped'
      : 'error'
    useStore.getState().settleGenerationRequest(
      request.chat_id,
      status,
      undefined,
      authority.requestAuthorityId ?? undefined,
    )
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export function resetGenerationRecoveryGuardsForTests(): void {
  useStore.setState({ generationRequests: {} })
  gapRecoveryStates.clear()
  __generationRecoveryTesting.configureStopConvergence()
}
const agentActivityRecoveryInFlight = new Map<string, Promise<void>>()

/** Fetch terminal status-only runs once per chat at a time and merge idempotently. */
export function recoverAgentActivityRuns(chatId: string, options?: RequestOptions): Promise<void> {
  if (!chatId) return Promise.resolve()
  const existing = agentActivityRecoveryInFlight.get(chatId)
  if (existing) return existing
  const request = chatsApi.listAgentActivityRuns(chatId, options)
    .then((response) => {
      const state = useStore.getState()
      if (state.activeChatId === chatId && Array.isArray(response.runs)) {
        state.mergeAgentActivityRuns(response.runs)
      }
    })
    .catch(() => { /* activity recovery is best effort */ })
    .finally(() => {
      agentActivityRecoveryInFlight.delete(chatId)
    })
  agentActivityRecoveryInFlight.set(chatId, request)
  return request
}
function getLocalStreamingType(generationType?: string) {
  return generationType === 'impersonate' ? 'impersonate_draft' : generationType
}

/**
 * Poll the backend generation pool for a chat and re-sync local streaming
 * state. Safe to call repeatedly — the pool is authoritative and cumulative,
 * and `reconcileStreamContent/Reasoning` apply snapshots monotonically (a
 * snapshot that raced newer live WS tokens can never rewind the buffer).
 *
 * When already streaming the same generation, the local buffer lengths are
 * sent with the poll so the server returns only the unseen tail (delta)
 * instead of re-shipping the full accumulated content every time.
 *
 * Triggered on: initial chat load, tab becoming visible, WS reconnect, a
 * lightweight watchdog poll while a generation is active, and immediately
 * when a live segment's offset reveals a gap in the local buffer.
 */
export type GenerationRecoveryOutcome = 'applied' | 'stale' | 'ignored' | 'failed'

export async function recoverPooledGeneration(chatId: string): Promise<GenerationRecoveryOutcome> {
  if (!chatId) return 'ignored'
  const state = useStore.getState()
  if (state.activeChatId !== chatId) return 'ignored'
  if (state.mpRoomId && !state.mpIsHost && state.mpChatId === chatId) return 'ignored'
  // Chat exit keeps one frozen stream frame mounted for its short animation.
  // Recovery must not resume writes into that fading subtree.
  if (state.streamingNavigationPaused) return 'ignored'

  const request = captureGenerationRequest(chatId, state.activeGenerationId)

  let known: { generationId: string; contentLen: number; reasoningLen: number } | undefined
  if (state.isStreaming && state.activeGenerationId) {
    const buffers = state.getStreamBuffers()
    known = {
      generationId: state.activeGenerationId,
      contentLen: buffers.content.length,
      reasoningLen: buffers.reasoning.length,
    }
  }

  let genStatus
  try {
    genStatus = await generateApi.getStatus(chatId, known)
  } catch {
    return 'failed'
  }

  const latest = useStore.getState()
  if (latest.activeChatId !== chatId) return 'ignored'
  if (request.epoch > 0 && !isGenerationRequestCurrent(request, genStatus.generationId, genStatus.active)) return 'stale'

  // A fenced active pool snapshot identifies this exact lifecycle. Wire the
  // lifecycle first because startStreaming clears prior-run metadata, then
  // project provider/model verbatim without guessing from the model name.
  if (genStatus.active && genStatus.generationId) {
    const status = genStatus.status === 'assembling' || genStatus.status === 'waiting'
      ? 'queued'
      : 'working'
    if (!acceptGenerationStarted(
      chatId,
      genStatus.generationId,
      genStatus.requestAuthorityId,
      status,
    )) return 'stale'
    if (!latest.isStreaming || latest.activeGenerationId !== genStatus.generationId) {
      latest.startStreaming(
        genStatus.generationId,
        genStatus.targetMessageId,
        genStatus.status === 'council' ? undefined : getLocalStreamingType(genStatus.generationType),
      )
    }
    latest.setGenerationProviderMetadata({
      provider: genStatus.provider ?? null,
      model: genStatus.model ?? null,
    })
    latest.setStreamingSwipeId(genStatus.targetSwipeId ?? null)
  }

  if (
    genStatus.active &&
    genStatus.generationId &&
    genStatus.status === 'council' &&
    genStatus.councilRetryPending &&
    genStatus.councilToolsFailure
  ) {
    latest.setCouncilExecuting(false)
    const existingFailure = latest.councilToolsFailure
    if (existingFailure?.generationId !== genStatus.generationId) {
      latest.setCouncilToolsFailure(genStatus.councilToolsFailure)
      const { showCouncilRetryModal } = await import('@/hooks/useCouncilEvents')
      const current = useStore.getState()
      if (
        current.activeChatId === chatId &&
        isGenerationRequestCurrent(request, genStatus.generationId, true)
      ) {
        showCouncilRetryModal(genStatus.councilToolsFailure)
      }
    }
    return 'applied'
  }

  if (genStatus.active && genStatus.generationId && (genStatus.status === 'streaming' || genStatus.status === 'reasoning')) {
    if (genStatus.content) latest.reconcileStreamContent(genStatus.content, genStatus.contentOffset ?? 0)
    if (genStatus.reasoning) latest.reconcileStreamReasoning(genStatus.reasoning, genStatus.reasoningOffset ?? 0)
    if (genStatus.reasoningDurationMs) {
      useStore.setState({ streamingReasoningDuration: genStatus.reasoningDurationMs })
    } else if (genStatus.reasoningStartedAt) {
      latest.setStreamingReasoningStartedAt(genStatus.reasoningStartedAt)
    }
    return 'applied'
  }

  if (genStatus.active && genStatus.generationId) {
    return 'applied'
  }

  if (!genStatus.active) {
    if (!isGenerationRequestCurrent(request, genStatus.generationId, false)) return 'stale'
    const completedImpersonateDraft =
      genStatus.status === 'completed' &&
      genStatus.generationType === 'impersonate' &&
      !genStatus.completedMessageId

    let draftContent: string | null = null
    if (completedImpersonateDraft && typeof genStatus.content === 'string') {
      const offset = genStatus.contentOffset ?? 0
      draftContent = offset > 0
        ? latest.getStreamBuffers().content.slice(0, offset) + genStatus.content
        : genStatus.content
    }

    // An inactive pool may no longer retain the retired generation ID. The
    // captured authority epoch still fences this response against a newer run.
    const sameGeneration =
      genStatus.generationId == null ||
      (!latest.activeGenerationId && !request.generationId) ||
      latest.activeGenerationId === genStatus.generationId ||
      (!!request.generationId && request.generationId === genStatus.generationId)
    if (latest.isStreaming && sameGeneration) {
      if (genStatus.error) {
        latest.setStreamingError(genStatus.error)
      } else if (completedImpersonateDraft || genStatus.completedMessageId) {
        latest.endStreaming()
      } else {
        latest.stopStreaming()
      }
    }

    if (draftContent != null) {
      if (!isGenerationRequestCurrent(request, genStatus.generationId, false)) return 'stale'
      latest.setImpersonateDraftContent(draftContent)
      return 'applied'
    }
    if (!genStatus.completedMessageId) return 'applied'

    const pageSize = latest.messagesPerPage || 50
    try {
      const fresh = await messagesApi.list(chatId, { limit: pageSize, tail: true })
      const after = useStore.getState()
      if (
        after.activeChatId === chatId &&
        isGenerationRequestCurrent(request, genStatus.generationId, false)
      ) {
        after.setMessages(fresh.data, fresh.total)
      }
    } catch {
      return 'failed'
    }
  }
  return 'applied'
}

// ── Gap recovery ─────────────────────────────────────────────────────────────
// Fired when a live WS segment's offset is ahead of the local buffer (we
interface GapRecoveryState {
  inFlight: boolean
  followUpQueued: boolean
  followUpAttempted: boolean
}

const gapRecoveryStates = new Map<string, GapRecoveryState>()

function getGapRecoveryState(chatId: string): GapRecoveryState {
  let state = gapRecoveryStates.get(chatId)
  if (!state) {
    state = { inFlight: false, followUpQueued: false, followUpAttempted: false }
    gapRecoveryStates.set(chatId, state)
  }
  return state
}

function runGapRecovery(chatId: string, state: GapRecoveryState): void {
  state.inFlight = true
  recoverPooledGeneration(chatId)
    .catch((): GenerationRecoveryOutcome => 'failed')
    .then((outcome) => {
      if (outcome === 'stale' && state.followUpQueued && !state.followUpAttempted) {
        state.followUpAttempted = true
        state.followUpQueued = false
        return recoverPooledGeneration(chatId)
      }
      return outcome
    })
    .catch(() => { /* best-effort */ })
    .finally(() => {
      state.inFlight = false
      state.followUpQueued = false
      state.followUpAttempted = false
      gapRecoveryStates.delete(chatId)
    })
}

export function requestStreamGapRecovery(chatId: string): void {
  if (!chatId) return
  const state = getGapRecoveryState(chatId)
  if (state.inFlight) {
    // One additional request is enough to observe the generation that may
    // become authoritative while the first status response is in flight.
    state.followUpQueued = true
    return
  }
  runGapRecovery(chatId, state)
}
