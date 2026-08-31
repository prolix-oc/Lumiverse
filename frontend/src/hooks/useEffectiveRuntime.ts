import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  effectiveRuntimeApi,
  normalizeChatAgentModeWriteResponse,
  normalizeEffectiveRuntimeResponse,
  EffectiveRuntimeProtocolError,
} from '@/api/effective-runtime'
import {
  createRuntimeScopeFingerprint,
  getRuntimeAuthorityRevision,
  getRuntimeSelectionSnapshot,
  invalidateRuntimeDecision,
  isCurrentRuntimeDisplayRequest,
  nextRuntimeDisplayEpoch,
  publishRuntimeDecision,
  redactRuntimeDecision,
  setOneTurnRuntimeMode,
  subscribeRuntimeSelection,
  subscribeRuntimeAuthority,
} from '@/lib/agentRuntimeSelection'
import type {
  AgentRuntimeMode,
  AgentRuntimeRepairCategory,
  ChatAgentModeWriteResponseV1,
  EffectiveRuntimeDisplayV1,
  EffectiveRuntimeRequestV1,
  GenerationTargetV1,
} from '@/types/effective-runtime'
import { isAgenticGenerationType, repairCategoriesForDecision } from '@/types/effective-runtime'

export type ResetChatMode = (
  chatId: string,
  expectedRevision: number,
) => Promise<ChatAgentModeWriteResponseV1>

export type UseEffectiveRuntimeDependencies = Pick<typeof effectiveRuntimeApi, 'resolve' | 'setChatMode'> & {
  /** DELETE /chats/:id/agent-mode; absent only for legacy test doubles. */
  resetChatMode?: ResetChatMode
}
export interface UseEffectiveRuntimeOptions {
  chatId: string
  generationType: string
  messageId?: string | null
  swipeId?: number | null
  branchId?: string | null
  targetCharacterId?: string | null
  logicalConnectionId?: string | null
  presetId?: string | null
  forcePresetId?: boolean
  personaId?: string | null
  supported?: boolean
  dependencies?: UseEffectiveRuntimeDependencies
}

export interface EffectiveRuntimeState {
  decision: EffectiveRuntimeDisplayV1 | null
  inspection: EffectiveRuntimeDisplayV1['inspection'] | null
  responseOmission: EffectiveRuntimeDisplayV1['responseOmission']
  mode: AgentRuntimeMode
  oneTurnMode: AgentRuntimeMode | null
  pendingOneTurnMode?: AgentRuntimeMode | null
  loading: boolean
  savingOverride: boolean
  activeGenerationMode: AgentRuntimeMode | null
  error: Error | null
  canShowSelector: boolean
  /** True when the resolved decision can accept a durable mode write. */
  canSetChatOverride?: boolean
  /** True only when a server-backed DELETE reset is available. */
  canResetChatOverride?: boolean
  /** Why the surface is Response-only; never silently hide unavailable WORK. */
  responseOnlyReason?:
    | 'loading'
    | 'error'
    | 'unsupported_surface'
    | 'agents_disabled'
    | 'repair_required'
    | 'unavailable'
  repairCategories: AgentRuntimeRepairCategory[]
  selectOneTurnMode(mode: AgentRuntimeMode): void
  saveChatOverride(mode: AgentRuntimeMode | null): Promise<void>
  resetChatOverride?: () => Promise<void>
  refresh(): Promise<void>
}
interface RuntimeResolutionResult {
  published: boolean
  retry: boolean
}


function sameTarget(left: GenerationTargetV1, right: GenerationTargetV1): boolean {
  if (left.generationType !== right.generationType) return false
  const optionalKeys = ['messageId', 'swipeId', 'branchId', 'targetCharacterId', 'revision'] as const
  return optionalKeys.every((key) => {
    const leftPresent = Object.hasOwn(left, key)
    const rightPresent = Object.hasOwn(right, key)
    return leftPresent === rightPresent && (!leftPresent || left[key] === right[key])
  })
}


interface PendingRuntimeWrite {
  inFlight: number
  generation: number
  dirty: boolean
  draining: boolean
  barrier: Promise<void>
  barrierResolve: (() => void) | null
  pulse: Promise<void> | null
  pulseResolve: (() => void) | null
  abortController: AbortController | null
  failure: Error | null
  scopeRevision: number
  closed: boolean
}

function createPendingRuntimeWrite(scopeRevision: number): PendingRuntimeWrite {
  let barrierResolve!: () => void
  const barrier = new Promise<void>((resolve) => {
    barrierResolve = resolve
  })
  return {
    inFlight: 0,
    generation: 0,
    dirty: false,
    draining: false,
    barrier,
    barrierResolve,
    pulse: null,
    pulseResolve: null,
    abortController: null,
    failure: null,
    scopeRevision,
    closed: false,
  }
}

function signalPendingRuntimeWrite(state: PendingRuntimeWrite): void {
  const resolve = state.pulseResolve
  state.pulseResolve = null
  state.pulse = null
  resolve?.()
}

/** First durable chat-mode writes use the zero revision; later writes must CAS the observed revision. */
export function chatModeExpectedRevision(
  chatOverride: EffectiveRuntimeDisplayV1['chatOverride'] | null | undefined,
  latestRevision?: number | null,
): number {
  return Math.max(chatOverride?.revision ?? 0, latestRevision ?? 0)
}

export function acceptEffectiveRuntimeResponse(
  chatId: string,
  requestEpoch: number,
  target: GenerationTargetV1,
  response: unknown,
  scopeFingerprint?: string,
): EffectiveRuntimeDisplayV1 | null {
  const normalized = normalizeEffectiveRuntimeResponse(response, { chatId, target })
  if (!isCurrentRuntimeDisplayRequest(chatId, requestEpoch)) return null
  publishRuntimeDecision(normalized, requestEpoch, scopeFingerprint, 'display')
  return redactRuntimeDecision(normalized)
}

export function useEffectiveRuntime(options: UseEffectiveRuntimeOptions): EffectiveRuntimeState {
  const {
    chatId,
    generationType,
    messageId = null,
    swipeId = null,
    branchId = null,
    targetCharacterId = null,
    logicalConnectionId = null,
    presetId = null,
    forcePresetId,
    personaId = null,
    supported = true,
    dependencies = effectiveRuntimeApi,
  } = options
  const target = useMemo<GenerationTargetV1 | null>(() => (
    supported && isAgenticGenerationType(generationType)
      ? {
          generationType,
          messageId,
          swipeId,
          branchId,
          targetCharacterId,
          revision: null,
        }
      : null
  ), [branchId, generationType, messageId, supported, swipeId, targetCharacterId])
  const scopeFingerprint = useMemo(() => createRuntimeScopeFingerprint({
    chatId,
    generationType,
    messageId,
    swipeId,
    branchId,
    targetCharacterId,
    logicalConnectionId,
    presetId,
    forcePresetId,
    personaId,
    supported,
  }), [
    branchId,
    chatId,
    forcePresetId,
    generationType,
    logicalConnectionId,
    messageId,
    personaId,
    presetId,
    supported,
    swipeId,
    targetCharacterId,
  ])
  const runtimeAuthorityRevision = useSyncExternalStore(
    subscribeRuntimeAuthority,
    getRuntimeAuthorityRevision,
    getRuntimeAuthorityRevision,
  )
  const scopeRef = useRef<{ fingerprint: string; authorityRevision: number; revision: number }>({
    fingerprint: scopeFingerprint,
    authorityRevision: runtimeAuthorityRevision,
    revision: 0,
  })
  if (
    scopeRef.current.fingerprint !== scopeFingerprint
    || scopeRef.current.authorityRevision !== runtimeAuthorityRevision
  ) {
    scopeRef.current = {
      fingerprint: scopeFingerprint,
      authorityRevision: runtimeAuthorityRevision,
      revision: scopeRef.current.revision + 1,
    }
  }
  const previousScopeFingerprintRef = useRef(scopeFingerprint)
  const mountedRef = useRef(false)
  const pendingWritesRef = useRef(new Map<string, PendingRuntimeWrite>())
  const savedChatModeRevisions = useRef(new Map<string, number>())
  const [loading, setLoading] = useState(false)
  const [savingOverride, setSavingOverride] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [decision, setDecision] = useState<EffectiveRuntimeDisplayV1 | null>(null)
  const [decisionChatId, setDecisionChatId] = useState<string | null>(null)
  const [decisionScopeFingerprint, setDecisionScopeFingerprint] = useState<string | null>(null)
  const selection = useSyncExternalStore(
    useCallback((listener) => subscribeRuntimeSelection(chatId, listener), [chatId]),
    useCallback(() => getRuntimeSelectionSnapshot(chatId), [chatId]),
    useCallback(() => getRuntimeSelectionSnapshot(chatId), [chatId]),
  )
  const wakePendingWrites = useCallback(() => {
    for (const state of pendingWritesRef.current.values()) {
      state.abortController?.abort()
      signalPendingRuntimeWrite(state)
    }
  }, [])


  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      wakePendingWrites()
    }
  }, [wakePendingWrites])

  useEffect(() => {
  const scopeChanged = previousScopeFingerprintRef.current !== scopeFingerprint
  previousScopeFingerprintRef.current = scopeFingerprint
  if (scopeChanged) invalidateRuntimeDecision(chatId)
  wakePendingWrites()
  setSavingOverride(false)
  setError(null)
  // Do not let a previous preset/connection/persona/target decision remain
  // visible for the new authority scope while its replacement resolves.
  setDecision(null)
  setDecisionChatId(null)
  setDecisionScopeFingerprint(null)
  }, [chatId, runtimeAuthorityRevision, scopeFingerprint, wakePendingWrites])

  const resolve = useCallback(async (
    signal?: AbortSignal,
    reconciliationGuard?: () => boolean,
  ): Promise<RuntimeResolutionResult> => {
    const expectedChatId = chatId
    const expectedTarget = target
    const expectedFingerprint = scopeFingerprint
    const expectedScopeRevision = scopeRef.current.revision
    const isCurrentScope = () => (
      mountedRef.current
      && scopeRef.current.fingerprint === expectedFingerprint
      && scopeRef.current.revision === expectedScopeRevision
    )
    const isCurrentReconciliation = () => reconciliationGuard?.() ?? true
    if (!isCurrentScope() || !isCurrentReconciliation()) return { published: false, retry: false }
    if (!expectedTarget) {
      setDecision(null)
      setDecisionChatId(null)
      setDecisionScopeFingerprint(null)
      setLoading(false)
      setError(null)
      return { published: true, retry: false }
    }
    const requestEpoch = nextRuntimeDisplayEpoch(expectedChatId)
    const request: EffectiveRuntimeRequestV1 = {
      chatId: expectedChatId,
      connectionId: logicalConnectionId,
      presetId,
      forcePresetId,
      personaId,
      targetCharacterId,
      generationType: expectedTarget.generationType,
      target: expectedTarget,
      requestEpoch,
    }
    setLoading(true)
    setError(null)
    try {
      const response = await dependencies.resolve(request, { signal })
      if (!isCurrentScope() || !isCurrentReconciliation()) {
        return { published: false, retry: false }
      }
      if (!isCurrentRuntimeDisplayRequest(expectedChatId, requestEpoch)) {
        return { published: false, retry: true }
      }
      const normalized = normalizeEffectiveRuntimeResponse(response, {
        chatId: expectedChatId,
        target: expectedTarget,
      })
      const acceptedScopeFingerprint = createRuntimeScopeFingerprint({
        chatId: expectedChatId,
        generationType: expectedTarget.generationType,
        messageId: expectedTarget.messageId,
        swipeId: expectedTarget.swipeId,
        branchId: expectedTarget.branchId,
        targetCharacterId: expectedTarget.targetCharacterId,
        logicalConnectionId,
        presetId,
        forcePresetId,
        personaId,
        supported,
      }, normalized)
      const accepted = acceptEffectiveRuntimeResponse(
        expectedChatId,
        requestEpoch,
        expectedTarget,
        normalized,
        acceptedScopeFingerprint,
      )
      if (!accepted) return { published: false, retry: false }
      setDecision(accepted)
      setDecisionChatId(expectedChatId)
      setDecisionScopeFingerprint(acceptedScopeFingerprint)
      return { published: true, retry: false }
    } catch (cause) {
      if (signal?.aborted || !isCurrentScope() || !isCurrentReconciliation()) {
        return { published: false, retry: false }
      }
      if (!isCurrentRuntimeDisplayRequest(expectedChatId, requestEpoch)) {
        return { published: false, retry: true }
      }
      setError(cause instanceof Error ? cause : new Error('effective_runtime_failed'))
      if (!(cause instanceof EffectiveRuntimeProtocolError)) {
        setDecision(null)
        setDecisionChatId(null)
        setDecisionScopeFingerprint(null)
      }
      return { published: false, retry: false }
    } finally {
      if (
        isCurrentScope()
        && isCurrentReconciliation()
        && isCurrentRuntimeDisplayRequest(expectedChatId, requestEpoch)
      ) setLoading(false)
    }
  }, [
    chatId,
    dependencies,
    forcePresetId,
    logicalConnectionId,
    personaId,
    presetId,
    runtimeAuthorityRevision,
    scopeFingerprint,
    supported,
    target,
    targetCharacterId,
  ])

  useEffect(() => {
    const controller = new AbortController()
    void resolve(controller.signal)
    return () => controller.abort()
  }, [resolve])


  const selectOneTurnMode = useCallback((mode: AgentRuntimeMode) => {
    setOneTurnRuntimeMode(chatId, mode)
  }, [chatId])

  const settleWrite = useCallback(async (
    state: PendingRuntimeWrite,
    fingerprint: string,
    scopeRevision: number,
    resolveForScope: (
      signal?: AbortSignal,
      reconciliationGuard?: () => boolean,
    ) => Promise<RuntimeResolutionResult>,
  ) => {
    state.inFlight = Math.max(0, state.inFlight - 1)
    state.generation += 1
    state.dirty = true
    signalPendingRuntimeWrite(state)
    const barrier = state.barrier
    if (state.closed) {
      await barrier
      return
    }
    const finish = () => {
      if (state.closed) return
      state.abortController?.abort()
      state.closed = true
      state.draining = false
      state.dirty = false
      signalPendingRuntimeWrite(state)
      const resolveBarrier = state.barrierResolve
      state.barrierResolve = null
      resolveBarrier?.()
      if (pendingWritesRef.current.get(fingerprint) === state) {
        pendingWritesRef.current.delete(fingerprint)
      }
      const isCurrentScope = (
        mountedRef.current
        && scopeRef.current.fingerprint === fingerprint
        && scopeRef.current.revision === scopeRevision
      )
      if (isCurrentScope && state.failure) setError(state.failure)
      if (isCurrentScope && !pendingWritesRef.current.has(fingerprint)) {
        setSavingOverride(false)
      }
    }
    const waitForPulse = (): Promise<void> => {
      if (state.pulse) return state.pulse
      let resolvePulse!: () => void
      const pulse = new Promise<void>((resolve) => {
        resolvePulse = resolve
      })
      state.pulse = pulse
      state.pulseResolve = resolvePulse
      return pulse
    }
    const drain = async (): Promise<void> => {
      while (!state.closed) {
        if (
          !mountedRef.current
          || scopeRef.current.fingerprint !== fingerprint
          || scopeRef.current.revision !== scopeRevision
        ) {
          finish()
          return
        }
        if (state.inFlight > 0) {
          await waitForPulse()
          continue
        }
        const reconciliationGeneration = state.generation
        state.dirty = false
        const isCurrentReconciliation = () => (
          mountedRef.current
          && state.inFlight === 0
          && state.generation === reconciliationGeneration
          && !state.dirty
          && scopeRef.current.fingerprint === fingerprint
          && scopeRef.current.revision === scopeRevision
        )
        const controller = new AbortController()
        state.abortController = controller
        let resolveAbort!: () => void
        const abortResult: RuntimeResolutionResult = { published: false, retry: false }
        const onAbort = () => resolveAbort()
        const abortPromise = new Promise<RuntimeResolutionResult>((resolve) => {
          resolveAbort = () => resolve(abortResult)
          if (controller.signal.aborted) resolve(abortResult)
        })
        controller.signal.addEventListener('abort', onAbort, { once: true })
        let resolutionResult: RuntimeResolutionResult
        try {
          resolutionResult = await Promise.race([
            resolveForScope(controller.signal, isCurrentReconciliation),
            abortPromise,
          ])
        } catch {
          finish()
          return
        } finally {
          controller.signal.removeEventListener('abort', onAbort)
          if (state.abortController === controller) state.abortController = null
        }
        if (resolutionResult.retry) {
          state.dirty = true
          continue
        }
        if (
          !mountedRef.current
          || scopeRef.current.fingerprint !== fingerprint
          || scopeRef.current.revision !== scopeRevision
        ) {
          finish()
          return
        }
        if (
          state.inFlight !== 0
          || state.generation !== reconciliationGeneration
          || state.dirty
        ) continue
        finish()
        return
      }
    }
    if (!state.draining) {
      state.draining = true
      void drain()
    }
    await barrier
  }, [mountedRef])

  const selectionDecisionScopeFingerprint = selection.decision
    ? createRuntimeScopeFingerprint({
        chatId,
        generationType,
        messageId,
        swipeId,
        branchId,
        targetCharacterId,
        logicalConnectionId,
        presetId,
        forcePresetId,
        personaId,
        supported,
      }, selection.decision)
    : null
  const projectedDecision = selection.decision
    && selection.decision.chatId === chatId
    && target
    && sameTarget(selection.decision.target, target)
    && selection.scopeFingerprint === selectionDecisionScopeFingerprint
    ? selection.decision
    : decisionChatId === chatId
      && decision
      && target
      && sameTarget(decision.target, target)
      && decisionScopeFingerprint === createRuntimeScopeFingerprint({
        chatId,
        generationType,
        messageId,
        swipeId,
        branchId,
        targetCharacterId,
        logicalConnectionId,
        presetId,
        forcePresetId,
        personaId,
        supported,
      }, decision)
      ? decision
      : null
  const saveChatOverride = useCallback(async (mode: AgentRuntimeMode | null) => {
    const expectedChatId = chatId
    const expectedFingerprint = scopeFingerprint
    const expectedScopeRevision = scopeRef.current.revision
    const isCurrentScope = () => (
      mountedRef.current
      && scopeRef.current.fingerprint === expectedFingerprint
      && scopeRef.current.revision === expectedScopeRevision
    )
    let pendingWrite = pendingWritesRef.current.get(expectedFingerprint)
    if (!pendingWrite || pendingWrite.scopeRevision !== expectedScopeRevision) {
      pendingWrite = createPendingRuntimeWrite(expectedScopeRevision)
      pendingWritesRef.current.set(expectedFingerprint, pendingWrite)
    }
    pendingWrite.inFlight += 1
    const expectedRevision = chatModeExpectedRevision(
      projectedDecision?.chatOverride,
      savedChatModeRevisions.current.get(expectedChatId),
    )
    setSavingOverride(true)
    setError(null)
    try {
      const response = normalizeChatAgentModeWriteResponse(
        await dependencies.setChatMode(expectedChatId, {
          mode,
          expectedRevision,
        }),
        expectedChatId,
      )
      if (Number.isSafeInteger(response.revision)) {
        const previousRevision = savedChatModeRevisions.current.get(expectedChatId)
        if (previousRevision === undefined || previousRevision < response.revision) {
          savedChatModeRevisions.current.set(expectedChatId, response.revision)
        }
      }
      if (
        isCurrentScope()
        && getRuntimeSelectionSnapshot(expectedChatId).activeGenerationMode === null
      ) {
        setOneTurnRuntimeMode(expectedChatId, null)
      }
    } catch (cause) {
      const writeError = cause instanceof Error ? cause : new Error('chat_mode_write_failed')
      pendingWrite.failure = writeError
      if (isCurrentScope()) setError(writeError)
      throw cause
    } finally {
      await settleWrite(pendingWrite, expectedFingerprint, expectedScopeRevision, resolve)
    }
  }, [
    chatId,
    dependencies,
    projectedDecision?.chatOverride?.revision,
    resolve,
    scopeFingerprint,
    target,
  ])

  const repairCategories = projectedDecision ? repairCategoriesForDecision(projectedDecision) : []
  const canShowSelector = !!projectedDecision
    && supported
    && projectedDecision.agentsEnabled
    && projectedDecision.allowedModes.includes('response')
    && projectedDecision.allowedModes.includes('agentic')
  const resetChatOverride = useCallback(async () => {
    const reset = dependencies.resetChatMode
    if (!reset) {
      const unavailable = new Error('chat_mode_reset_unavailable')
      if (mountedRef.current) setError(unavailable)
      throw unavailable
    }
    const expectedChatId = chatId
    const expectedFingerprint = scopeFingerprint
    const expectedScopeRevision = scopeRef.current.revision
    const isCurrentScope = () => (
      mountedRef.current
      && scopeRef.current.fingerprint === expectedFingerprint
      && scopeRef.current.revision === expectedScopeRevision
    )
    let pendingWrite = pendingWritesRef.current.get(expectedFingerprint)
    if (!pendingWrite || pendingWrite.scopeRevision !== expectedScopeRevision) {
      pendingWrite = createPendingRuntimeWrite(expectedScopeRevision)
      pendingWritesRef.current.set(expectedFingerprint, pendingWrite)
    }
    pendingWrite.inFlight += 1
    const expectedRevision = chatModeExpectedRevision(
      projectedDecision?.chatOverride,
      savedChatModeRevisions.current.get(expectedChatId),
    )
    setSavingOverride(true)
    setError(null)
    try {
      const response = normalizeChatAgentModeWriteResponse(
        await reset(expectedChatId, expectedRevision),
        expectedChatId,
      )
      if (Number.isSafeInteger(response.revision)) {
        const previousRevision = savedChatModeRevisions.current.get(expectedChatId)
        if (previousRevision === undefined || previousRevision < response.revision) {
          savedChatModeRevisions.current.set(expectedChatId, response.revision)
        }
      }
      if (
        isCurrentScope()
        && getRuntimeSelectionSnapshot(expectedChatId).activeGenerationMode === null
      ) {
        setOneTurnRuntimeMode(expectedChatId, null)
      }
    } catch (cause) {
      const writeError = cause instanceof Error ? cause : new Error('chat_mode_reset_failed')
      pendingWrite.failure = writeError
      if (isCurrentScope()) setError(writeError)
      throw cause
    } finally {
      await settleWrite(pendingWrite, expectedFingerprint, expectedScopeRevision, resolve)
    }
  }, [
    chatId,
    dependencies.resetChatMode,
    projectedDecision?.chatOverride?.revision,
    resolve,
    scopeFingerprint,
  ])
  const mode = selection.oneTurnMode ?? projectedDecision?.effectiveMode ?? 'response'
  const canSetChatOverride = !!projectedDecision
    && supported
    && projectedDecision.allowedModes.includes('response')
  const canResetChatOverride = !!projectedDecision?.chatOverride
    && typeof dependencies.resetChatMode === 'function'
  const responseOnlyReason = !supported || !target
    ? 'unsupported_surface' as const
    : loading
      ? 'loading' as const
      : error
        ? 'error' as const
        : !projectedDecision
          ? 'unavailable' as const
          : !projectedDecision.agentsEnabled
            || !projectedDecision.allowedModes.includes('agentic')
            ? 'agents_disabled' as const
            : !projectedDecision.capabilityReadiness.ready
              || projectedDecision.capabilityReadiness.missing.length > 0
              || repairCategories.length > 0
              ? 'repair_required' as const
              : 'unavailable' as const
  const refresh = useCallback(async (): Promise<void> => {
    await resolve()
  }, [resolve])

  return {
    decision: projectedDecision,
    inspection: projectedDecision?.inspection ?? null,
    responseOmission: projectedDecision?.responseOmission ?? null,
    mode,
    oneTurnMode: selection.oneTurnMode,
    pendingOneTurnMode: selection.pendingOneTurnMode,
    loading,
    savingOverride,
    activeGenerationMode: selection.activeGenerationMode,
    error,
    canShowSelector,
    canSetChatOverride,
    canResetChatOverride,
    responseOnlyReason,
    repairCategories,
    selectOneTurnMode,
    saveChatOverride,
    resetChatOverride: dependencies.resetChatMode ? resetChatOverride : undefined,
    refresh,
  }
}
