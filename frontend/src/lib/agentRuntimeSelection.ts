import { effectiveRuntimeApi, normalizeEffectiveRuntimeResponse } from '@/api/effective-runtime'
import type {
  AgentRuntimeMode,
  AgentRuntimeRepairCategory,
  AgentRuntimeRepairCode,
  EffectiveRuntimeDisplayV1,
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
  GenerationTargetV1,
} from '@/types/effective-runtime'
import { isAgenticGenerationType } from '@/types/effective-runtime'

export interface RuntimeGenerationRequest {
  chat_id: string
  connection_id?: string
  persona_id?: string
  preset_id?: string
  force_preset_id?: boolean
  message_id?: string
  swipe_id?: number
  generation_type?: string
  target_character_id?: string
  mode?: AgentRuntimeMode
  runtime_decision_token?: string
  request_epoch?: number
}

export interface RuntimeSelectionSnapshot {
  oneTurnMode: AgentRuntimeMode | null
  /**
   * A selection made while a generation is already admitted is held for the
   * next turn. Keeping it out of `oneTurnMode` until the active mode is
   * released prevents dispatch guards from redirecting an in-flight request.
   */
  pendingOneTurnMode: AgentRuntimeMode | null
  effectiveMode: AgentRuntimeMode | null
  agenticReady: boolean
  generationType: string | null
  decision: EffectiveRuntimeDisplayV1 | null
  activeGenerationMode: AgentRuntimeMode | null
  /** Canonical local/public authority scope for the projected decision. */
  scopeFingerprint: string | null
}

export interface PreparedRuntimeRequest<T extends RuntimeGenerationRequest> {
  request: T & RuntimeGenerationRequest
  commitOneTurnSelection(): void
}
export interface RuntimePreparationOptions {
  signal?: AbortSignal
  /**
   * The caller persisted a chat-affecting row after the runtime display
   * decision was resolved. Force a new decision against that post-write
   * revision instead of consuming the cached one-use token.
   */
  forceRuntimeRefresh?: boolean
  /**
   * This generation surface cannot run Agentic (for example impersonation,
   * group, or multiplayer). Send an explicit Response request while leaving
   * the user's one-turn/durable Agentic selection untouched.
   */
  forceResponse?: boolean
}
const TARGET_OPTIONAL_KEYS = ['messageId', 'swipeId', 'branchId', 'targetCharacterId', 'revision'] as const

function targetIdentity(target: GenerationTargetV1): Record<string, unknown> {
  const result: Record<string, unknown> = { generationType: target.generationType }
  for (const key of TARGET_OPTIONAL_KEYS) {
    if (Object.hasOwn(target, key)) result[key] = target[key]
  }
  return result
}

function sameTargetIdentity(left: GenerationTargetV1, right: GenerationTargetV1): boolean {
  if (left.generationType !== right.generationType) return false
  for (const key of TARGET_OPTIONAL_KEYS) {
    const leftPresent = Object.hasOwn(left, key)
    const rightPresent = Object.hasOwn(right, key)
    if (leftPresent !== rightPresent) return false
    if (leftPresent && left[key] !== right[key]) return false
  }
  return true
}


function throwIfRuntimeAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('Generation cancelled', 'AbortError')
}

function addPendingRequestEpoch(chatId: string, requestEpoch: number): void {
  const pending = pendingRequestEpochs.get(chatId) ?? new Set<number>()
  pending.add(requestEpoch)
  pendingRequestEpochs.set(chatId, pending)
}

function removePendingRequestEpoch(chatId: string, requestEpoch: number): void {
  const pending = pendingRequestEpochs.get(chatId)
  if (!pending) return
  pending.delete(requestEpoch)
  if (pending.size === 0) pendingRequestEpochs.delete(chatId)
}


export interface RuntimeScopeInput {
  chatId: string
  generationType?: string | null
  messageId?: string | null
  swipeId?: number | null
  branchId?: string | null
  targetCharacterId?: string | null
  logicalConnectionId?: string | null
  presetId?: string | null
  forcePresetId?: boolean
  personaId?: string | null
  supported?: boolean
}

/**
 * One canonical frontend scope key for decisions and their one-use tokens.
 *
 * The local inputs are the authority requested by the caller. The public
 * decision fields are the authority selected by the backend (including the
 * concrete connection revisions and readiness evidence). Token/display cache
 * entries must match both halves before they are reused.
 */
export function createRuntimeScopeFingerprint(
  input: RuntimeScopeInput,
  decision?: EffectiveRuntimePublicResponseV1 | EffectiveRuntimeDisplayV1 | null,
): string {
  const localTarget: Record<string, unknown> = {
    generationType: input.generationType ?? null,
  }
  if (input.messageId !== undefined) localTarget.messageId = input.messageId
  if (input.swipeId !== undefined) localTarget.swipeId = input.swipeId
  if (input.branchId !== undefined) localTarget.branchId = input.branchId
  if (input.targetCharacterId !== undefined) localTarget.targetCharacterId = input.targetCharacterId
  const publicIdentity = decision
    ? {
        version: decision.version,
        chatId: decision.chatId,
        target: targetIdentity(decision.target),
        connection: {
          id: decision.connection.id,
          revision: decision.connection.revision,
          endpointRevision: decision.connection.endpointRevision,
          credentialRevision: decision.connection.credentialRevision,
          candidateRevision: decision.connection.candidateRevision,
        },
        preset: {
          id: decision.preset.id,
          revision: decision.preset.revision,
          source: decision.preset.source,
        },
        agentsEnabled: decision.agentsEnabled,
        allowedModes: [...decision.allowedModes],
        defaultMode: decision.defaultMode,
        requestedMode: decision.requestedMode,
        effectiveMode: decision.effectiveMode,
        runtimePolicy: decision.runtimePolicy,
        chatOverride: decision.chatOverride
          ? {
              mode: decision.chatOverride.mode,
              revision: decision.chatOverride.revision,
              state: decision.chatOverride.state,
              reviewCode: decision.chatOverride.reviewCode ?? null,
              acknowledged: decision.chatOverride.acknowledged ?? null,
            }
          : null,
        capabilityReadiness: {
          ready: decision.capabilityReadiness.ready,
          sameDomain: decision.capabilityReadiness.sameDomain,
          required: [...decision.capabilityReadiness.required],
          missing: [...decision.capabilityReadiness.missing],
          repairCodes: [...decision.capabilityReadiness.repairCodes],
          responseEscape: decision.capabilityReadiness.responseEscape,
        },
        repairCodes: [...decision.repairCodes],
      }
    : null
  return JSON.stringify({
    local: {
      chatId: input.chatId,
      ...localTarget,
      logicalConnectionId: input.logicalConnectionId ?? null,
      presetId: input.presetId ?? null,
      forcePresetId: input.forcePresetId ?? null,
      personaId: input.personaId ?? null,
      supported: input.supported ?? true,
    },
    public: publicIdentity,
  })
}
/**
 * Keep the local selection cache strictly public. Runtime decision tokens and
 * their expiry are admission material for the next request, never display
 * state or a value that may be exposed through the external-store snapshot.
 */
export function redactRuntimeDecision(
  response: EffectiveRuntimePublicResponseV1,
): EffectiveRuntimeDisplayV1 {
  const {
    runtimeDecisionToken: _runtimeDecisionToken,
    runtimeDecisionExpiresAt: _runtimeDecisionExpiresAt,
    ...display
  } = response
  return display
}

const EMPTY_SELECTION: RuntimeSelectionSnapshot = {
  oneTurnMode: null,
  pendingOneTurnMode: null,
  effectiveMode: null,
  agenticReady: false,
  generationType: null,
  decision: null,
  activeGenerationMode: null,
  scopeFingerprint: null,
}

const snapshots = new Map<string, RuntimeSelectionSnapshot>()
const listeners = new Map<string, Set<() => void>>()
const requestEpochs = new Map<string, number>()
const displayEpochs = new Map<string, number>()
const pendingRequestEpochs = new Map<string, Set<number>>()

const decisionTokens = new Map<string, {
  token: string
  requestEpoch: number
  epochKind: 'dispatch' | 'display'
  expiresAt: number
  target: GenerationTargetV1
  scopeFingerprint: string
}>()

let runtimeAuthorityRevision = 0
const runtimeAuthorityListeners = new Set<() => void>()

export function getRuntimeAuthorityRevision(): number {
  return runtimeAuthorityRevision
}

export function subscribeRuntimeAuthority(listener: () => void): () => void {
  runtimeAuthorityListeners.add(listener)
  return () => runtimeAuthorityListeners.delete(listener)
}

function publish(chatId: string, next: RuntimeSelectionSnapshot): void {
  snapshots.set(chatId, next)
  listeners.get(chatId)?.forEach((listener) => listener())
}

export function subscribeRuntimeSelection(chatId: string, listener: () => void): () => void {
  const chatListeners = listeners.get(chatId) ?? new Set<() => void>()
  chatListeners.add(listener)
  listeners.set(chatId, chatListeners)
  return () => {
    chatListeners.delete(listener)
    if (chatListeners.size === 0) listeners.delete(chatId)
  }
}

export function getRuntimeSelectionSnapshot(chatId: string): RuntimeSelectionSnapshot {
  return snapshots.get(chatId) ?? EMPTY_SELECTION
}

export function invalidateRuntimeDecision(chatId: string): void {
  decisionTokens.delete(chatId)
  nextRuntimeDisplayEpoch(chatId)
  const current = getRuntimeSelectionSnapshot(chatId)
  // An admitted generation owns its mode until it settles. Invalidation still
  // fences an unresolved preflight, but never changes the epoch of the active
  // request or causes an in-flight run to be redirected to Response.
  if (
    (pendingRequestEpochs.get(chatId)?.size ?? 0) > 0
    && current.activeGenerationMode === null
  ) {
    nextRuntimeRequestEpoch(chatId)
  }
}

/**
 * Commit point for any persisted preset or preset-profile authority write.
 * It invalidates one-use decisions, fences unresolved display/send requests,
 * and wakes every mounted runtime projection to resolve against the new state.
 */
export function commitRuntimeAuthorityMutation(): void {
  runtimeAuthorityRevision += 1
  const chatIds = new Set([
    ...snapshots.keys(),
    ...listeners.keys(),
    ...decisionTokens.keys(),
    ...pendingRequestEpochs.keys(),
  ])
  for (const chatId of chatIds) invalidateRuntimeDecision(chatId)
  for (const listener of runtimeAuthorityListeners) listener()
}

export function setOneTurnRuntimeMode(chatId: string, mode: AgentRuntimeMode | null): void {
  const current = getRuntimeSelectionSnapshot(chatId)
  if (current.activeGenerationMode !== null) {
    if (current.pendingOneTurnMode === mode) return
    // The composer can be reopened by another surface while a run is settling.
    // Keep the admitted mode stable and stage the new choice for the next turn.
    publish(chatId, { ...current, pendingOneTurnMode: mode })
    return
  }
  if (current.oneTurnMode === mode && current.pendingOneTurnMode === null) return
  // A mode choice is an authority change. Invalidate any cached one-use token
  // and fence a preflight that is still awaiting the backend decision.
  invalidateRuntimeDecision(chatId)
  publish(chatId, { ...current, oneTurnMode: mode, pendingOneTurnMode: null })
}

export function clearOneTurnRuntimeMode(chatId: string): void {
  setOneTurnRuntimeMode(chatId, null)
}

function completeOneTurnSelection(chatId: string, ambient: RuntimeSelectionSnapshot): void {
  const current = getRuntimeSelectionSnapshot(chatId)
  publish(chatId, {
    ...current,
    // A choice staged during the admitted run belongs to the next turn; the
    // current run's one-turn mode is consumed without clearing that choice.
    oneTurnMode: current.pendingOneTurnMode,
    pendingOneTurnMode: null,
    effectiveMode: ambient.effectiveMode,
    agenticReady: ambient.agenticReady,
    generationType: ambient.generationType,
    decision: ambient.decision,
    scopeFingerprint: ambient.scopeFingerprint,
  })
}

function completeResponseDispatch(
  chatId: string,
  ambient: RuntimeSelectionSnapshot = getRuntimeSelectionSnapshot(chatId),
): void {
  // A one-turn Response escape must not overwrite the durable Agentic
  // decision. Restore the ambient projection after dispatch so the next
  // generation resolves its durable mode instead of inheriting Response.
  completeOneTurnSelection(chatId, ambient)
}

export function resetActiveGenerationMode(chatId: string): void {
  const current = getRuntimeSelectionSnapshot(chatId)
  if (current.activeGenerationMode === null) return
  publish(chatId, {
    ...current,
    oneTurnMode: current.pendingOneTurnMode ?? current.oneTurnMode,
    pendingOneTurnMode: null,
    activeGenerationMode: null,
  })
}

function markPreparedGenerationMode(chatId: string, mode: AgentRuntimeMode): void {
  const current = getRuntimeSelectionSnapshot(chatId)
  publish(chatId, { ...current, activeGenerationMode: mode })
}

export function nextRuntimeRequestEpoch(chatId: string): number {
  const next = (requestEpochs.get(chatId) ?? 0) + 1
  requestEpochs.set(chatId, next)
  return next
}

export function isCurrentRuntimeRequest(chatId: string, requestEpoch: number): boolean {
  return requestEpochs.get(chatId) === requestEpoch
}
export function nextRuntimeDisplayEpoch(chatId: string): number {
  const next = (displayEpochs.get(chatId) ?? 0) + 1
  displayEpochs.set(chatId, next)
  return next
}

export function isCurrentRuntimeDisplayRequest(chatId: string, requestEpoch: number): boolean {
  return displayEpochs.get(chatId) === requestEpoch
}

function takeRuntimeDecisionToken(
  chatId: string,
  target: GenerationTargetV1,
  scopeFingerprint: string,
): { token: string; requestEpoch: number } | null {
  const cached = decisionTokens.get(chatId)
  if (!cached) return null
  decisionTokens.delete(chatId)
  if (cached.expiresAt <= Date.now()) return null
  const current = cached.epochKind === 'display'
    ? isCurrentRuntimeDisplayRequest(chatId, cached.requestEpoch)
    : isCurrentRuntimeRequest(chatId, cached.requestEpoch)
  if (!current) return null
  if (cached.scopeFingerprint !== scopeFingerprint) return null
  if (!sameTargetIdentity(cached.target, target)) return null
  return { token: cached.token, requestEpoch: cached.requestEpoch }
}

export function publishRuntimeDecision(
  response: unknown,
  requestEpoch: number,
  scopeFingerprint?: string,
  epochKind: 'dispatch' | 'display' = 'dispatch',
): void {
  const normalized = normalizeEffectiveRuntimeResponse(response)
  const current = getRuntimeSelectionSnapshot(normalized.chatId)
  const display = redactRuntimeDecision(normalized)
  const resolvedScopeFingerprint = scopeFingerprint ?? createRuntimeScopeFingerprint({
    chatId: normalized.chatId,
    generationType: normalized.target.generationType,
    messageId: normalized.target.messageId,
    swipeId: normalized.target.swipeId,
    branchId: normalized.target.branchId,
    targetCharacterId: normalized.target.targetCharacterId,
  }, display)
  if (normalized.runtimeDecisionToken !== null && normalized.runtimeDecisionExpiresAt !== null) {
    decisionTokens.set(normalized.chatId, {
      token: normalized.runtimeDecisionToken,
      requestEpoch,
      epochKind,
      expiresAt: normalized.runtimeDecisionExpiresAt,
      target: normalized.target,
      scopeFingerprint: resolvedScopeFingerprint,
    })
  } else {
    decisionTokens.delete(normalized.chatId)
  }
  publish(normalized.chatId, {
    ...current,
    effectiveMode: normalized.effectiveMode,
    agenticReady: normalized.capabilityReadiness.ready
      && normalized.agentsEnabled
      && normalized.allowedModes.includes('response')
      && normalized.allowedModes.includes('agentic'),
    generationType: normalized.target.generationType,
    decision: display,
    scopeFingerprint: resolvedScopeFingerprint,
  })
}

export class AgentRuntimePreflightError extends Error {
  constructor(
    public readonly code: 'decision_refresh_required' | 'agentic_unavailable' | 'agentic_unsupported_surface',
    public readonly repairCodes: readonly AgentRuntimeRepairCode[],
  ) {
    super(code)
    this.name = 'AgentRuntimePreflightError'
  }
}
const KNOWN_RUNTIME_ERROR_CODES: Record<string, true> = {
  not_found: true,
  invalid_request: true,
  decision_refresh_required: true,
  decision_capacity_exceeded: true,
  runtime_decision_unavailable: true,
  agentic_unsupported_surface: true,
  agentic_runtime_unavailable: true,
  agentic_preflight_failed: true,
  agentic_chat_busy: true,
  agentic_protocol_failure: true,
  agentic_work_exhausted: true,
  agentic_cancelled: true,
  agentic_timed_out: true,
  agentic_commit_failed: true,
  agentic_revision_conflict: true,
  agentic_provider_failure: true,
  agentic_internal_error: true,
  agent_config_missing: true,
  agent_config_disabled: true,
  agent_config_review_required: true,
  agent_config_repair_required: true,
  agentic_mode_not_allowed: true,
  agentic_slot_unresolved: true,
  agentic_slot_stale: true,
  agentic_capability_missing_generation: true,
  agentic_capability_missing_streaming: true,
  agentic_capability_missing_tool_calling: true,
  agentic_capability_missing_native_tool_continuation: true,
  agentic_capability_missing_tools_disabled_finalization: true,
  agentic_domain_mismatch: true,
  agentic_generation_type_unsupported: true,
  agentic_target_unsupported: true,
  agentic_input_revisions_incomplete: true,
  agentic_readiness_unavailable: true,
  agentic_kill_switch: true,
  agentic_connection_unavailable: true,
  agentic_response_escape: true,
  cognition_invalid: true,
  cognition_repair_required: true,
  cognition_missing_block_revision: true,
  cognition_missing_pack_revision: true,
  cognition_rule_invalid: true,
  cognition_template_invalid: true,
  cognition_context_unavailable: true,
  cognition_foreign_authority_blocked: true,
}
const RUNTIME_ERROR_REPAIR_CATEGORIES: Record<string, AgentRuntimeRepairCategory> = {
  agent_config_missing: 'readiness',
  agent_config_disabled: 'readiness',
  agent_config_review_required: 'readiness',
  agent_config_repair_required: 'readiness',
  agentic_mode_not_allowed: 'readiness',
  agentic_slot_unresolved: 'slot',
  agentic_slot_stale: 'slot',
  agentic_capability_missing_generation: 'provider',
  agentic_capability_missing_streaming: 'provider',
  agentic_capability_missing_tool_calling: 'provider',
  agentic_capability_missing_native_tool_continuation: 'provider',
  agentic_capability_missing_tools_disabled_finalization: 'provider',
  agentic_domain_mismatch: 'egress',
  agentic_generation_type_unsupported: 'readiness',
  agentic_target_unsupported: 'readiness',
  agentic_input_revisions_incomplete: 'readiness',
  agentic_readiness_unavailable: 'isolate',
  agentic_kill_switch: 'readiness',
  agentic_connection_unavailable: 'provider',
  agentic_response_escape: 'readiness',
  cognition_invalid: 'readiness',
  cognition_repair_required: 'readiness',
  cognition_missing_block_revision: 'readiness',
  cognition_missing_pack_revision: 'readiness',
  cognition_rule_invalid: 'readiness',
  cognition_template_invalid: 'readiness',
  cognition_context_unavailable: 'readiness',
  cognition_foreign_authority_blocked: 'readiness',
}


function normalizedRuntimeErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase()
  return code.length > 0 ? code : null
}

function extractRuntimeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const source = error as { code?: unknown; body?: unknown }
  const body = source.body && typeof source.body === 'object'
    ? source.body as { code?: unknown; errorCode?: unknown }
    : null
  return normalizedRuntimeErrorCode(body?.code)
    ?? normalizedRuntimeErrorCode(body?.errorCode)
    ?? normalizedRuntimeErrorCode(source.code)
}

/**
 * Convert known backend Agentic/decision failures into stable frontend
 * translation keys. Unknown provider/server messages remain available to the
 * caller as a last-resort diagnostic, but are never treated as localized
 * runtime failures.
 */
export function agentRuntimeErrorTranslationKey(error: unknown): string | null {
  if (error instanceof AgentRuntimePreflightError) {
    return agentRuntimePreflightTranslationKey(error)
  }
  const code = extractRuntimeErrorCode(error)
  if (!code || !KNOWN_RUNTIME_ERROR_CODES[code]) return null
  const repairCategory = RUNTIME_ERROR_REPAIR_CATEGORIES[code]
  return repairCategory
    ? `agentRuntime.repair.${repairCategory}`
    : `agentRuntime.errors.${code}`
}


export function agentRuntimePreflightTranslationKey(error: unknown): string | null {
  if (!(error instanceof AgentRuntimePreflightError)) return null
  if (error.code === 'decision_refresh_required') return 'agentRuntime.preflight.refreshRequired'
  if (error.code === 'agentic_unsupported_surface') return 'agentRuntime.errors.agentic_unsupported_surface'
  return 'agentRuntime.preflight.unavailable'
}

function targetFromGenerationRequest(request: RuntimeGenerationRequest): GenerationTargetV1 | null {
  const requestedGenerationType = request.generation_type ?? 'normal'
  if (!isAgenticGenerationType(requestedGenerationType)) return null
  // A delete-style regenerate has no concrete assistant target and is
  // intentionally treated as a normal turn by the backend. Once a target is
  // supplied, preserve the exact regenerate/message/swipe identity.
  const generationType = requestedGenerationType === 'regenerate' && request.message_id == null
    ? 'normal'
    : requestedGenerationType
  return {
    generationType,
    messageId: request.message_id ?? null,
    swipeId: request.swipe_id ?? null,
    branchId: null,
    targetCharacterId: request.target_character_id ?? null,
    revision: null,
  }
}

function effectiveRuntimeRequest(
  request: RuntimeGenerationRequest,
  target: GenerationTargetV1,
  mode: AgentRuntimeMode | undefined,
  requestEpoch: number,
): EffectiveRuntimeRequestV1 {
  return {
    chatId: request.chat_id,
    connectionId: request.connection_id ?? null,
    presetId: request.preset_id ?? null,
    forcePresetId: request.force_preset_id,
    personaId: request.persona_id ?? null,
    targetCharacterId: request.target_character_id ?? null,
    generationType: target.generationType,
    target,
    mode,
    requestEpoch,
  }
}

function responseGenerationRequest<T extends RuntimeGenerationRequest>(
  request: T,
  forceMode = false,
): T & RuntimeGenerationRequest {
  if (
    !forceMode
    && request.mode === undefined
    && request.runtime_decision_token === undefined
    && request.request_epoch === undefined
  ) return request
  return {
    ...request,
    mode: 'response',
    runtime_decision_token: undefined,
    request_epoch: undefined,
  }
}


export async function prepareAgentRuntimeRequest<T extends RuntimeGenerationRequest>(
  request: T,
  options: RuntimePreparationOptions = {},
): Promise<PreparedRuntimeRequest<T>> {
  throwIfRuntimeAborted(options.signal)
  const forceResponse = options.forceResponse === true
  if (!forceResponse && (options.forceRuntimeRefresh || request.mode === 'response')) {
    invalidateRuntimeDecision(request.chat_id)
  }
  // Clear the previous turn before any asynchronous settings/preset work can
  // leave an optimistic Response turn looking like a stale Agentic run.
  resetActiveGenerationMode(request.chat_id)
  const selection = getRuntimeSelectionSnapshot(request.chat_id)
  const target = targetFromGenerationRequest(request)
  if (!target) {
    const explicitResponse = forceResponse || request.mode === 'response'
    const agenticRequested = !explicitResponse && (
      selection.oneTurnMode === 'agentic'
      || request.mode === 'agentic'
      || request.runtime_decision_token !== undefined
      || (
        selection.oneTurnMode === null
        && request.mode === undefined
        && selection.effectiveMode === 'agentic'
      )
    )
    if (agenticRequested) {
      throw new AgentRuntimePreflightError('agentic_unsupported_surface', ['agentic_generation_type_unsupported'])
    }
    markPreparedGenerationMode(request.chat_id, 'response')
    return {
      request: responseGenerationRequest(request, true),
      // Forced Response surfaces must not consume or clear a selected
      // one-turn Agentic choice. An explicit user Response escape still
      // settles its one-turn selection through the normal path.
      commitOneTurnSelection: forceResponse
        ? () => undefined
        : () => completeResponseDispatch(request.chat_id, selection),
    }
  }

  const explicitMode = selection.oneTurnMode
  const explicitResponseSelected = forceResponse
    || request.mode === 'response'
    || explicitMode === 'response'
  const shouldPreflightAgentic = !forceResponse && request.mode !== 'response' && explicitMode !== 'response' && (
    request.mode === 'agentic'
      || explicitMode === 'agentic'
      || (
        explicitMode === null
        && request.mode !== 'response'
        && selection.effectiveMode === 'agentic'
      )
  )
  const scopeFingerprint = createRuntimeScopeFingerprint({
    chatId: request.chat_id,
    generationType: target.generationType,
    messageId: target.messageId,
    swipeId: target.swipeId,
    branchId: target.branchId,
    targetCharacterId: target.targetCharacterId,
    logicalConnectionId: request.connection_id,
    presetId: request.preset_id,
    forcePresetId: request.force_preset_id,
    personaId: request.persona_id,
  }, selection.decision)

  if (!shouldPreflightAgentic) {
    markPreparedGenerationMode(request.chat_id, 'response')
    return {
      request: responseGenerationRequest(
        request,
        explicitResponseSelected
          || explicitMode !== null
          || request.mode !== undefined
          || request.runtime_decision_token !== undefined
          || request.request_epoch !== undefined,
      ),
      commitOneTurnSelection: forceResponse || explicitMode === null
        ? () => undefined
        : () => completeResponseDispatch(request.chat_id, selection),
    }
  }


  const cachedToken = options.forceRuntimeRefresh
    ? null
    : takeRuntimeDecisionToken(request.chat_id, target, scopeFingerprint)
  if (cachedToken && selection.agenticReady && selection.effectiveMode === 'agentic') {
    markPreparedGenerationMode(request.chat_id, 'agentic')
    return {
      request: {
        ...request,
        generation_type: target.generationType,
        mode: 'agentic',
        runtime_decision_token: cachedToken.token,
        request_epoch: cachedToken.requestEpoch,
      },
      commitOneTurnSelection: explicitMode === null
        ? () => undefined
        : () => completeOneTurnSelection(request.chat_id, selection),
    }
  }

  const requestEpoch = nextRuntimeRequestEpoch(request.chat_id)
  addPendingRequestEpoch(request.chat_id, requestEpoch)
  let decision: EffectiveRuntimePublicResponseV1
  try {
    const payload = await effectiveRuntimeApi.resolve(effectiveRuntimeRequest(
      request,
      target,
      explicitMode ?? request.mode,
      requestEpoch,
    ), options.signal ? { signal: options.signal } : undefined)
    decision = normalizeEffectiveRuntimeResponse(payload, {
      chatId: request.chat_id,
      target,
    })
  } finally {
    removePendingRequestEpoch(request.chat_id, requestEpoch)
  }

  throwIfRuntimeAborted(options.signal)
  const currentSelection = getRuntimeSelectionSnapshot(request.chat_id)
  if (
    !isCurrentRuntimeRequest(request.chat_id, requestEpoch)
    || currentSelection.oneTurnMode !== explicitMode
  ) {
    throw new AgentRuntimePreflightError('decision_refresh_required', ['decision_refresh_required'])
  }
  const resolvedScopeFingerprint = createRuntimeScopeFingerprint({
    chatId: request.chat_id,
    generationType: target.generationType,
    messageId: target.messageId,
    branchId: target.branchId,
    swipeId: target.swipeId,
    targetCharacterId: target.targetCharacterId,
    logicalConnectionId: request.connection_id,
    presetId: request.preset_id,
    forcePresetId: request.force_preset_id,
    personaId: request.persona_id,
  }, decision)
  publishRuntimeDecision(decision, requestEpoch, resolvedScopeFingerprint)
  // This preflight returns the token directly to the pending generation; do
  // not leave a replayable copy in the display-decision cache.
  decisionTokens.delete(request.chat_id)
  const agenticReady = decision.effectiveMode === 'agentic'
    && decision.capabilityReadiness.ready
    && decision.runtimeDecisionToken !== null
  if (!agenticReady) {
    const repairCodes = [...decision.repairCodes, ...decision.capabilityReadiness.repairCodes]
    throw new AgentRuntimePreflightError('agentic_unavailable', repairCodes)
  }

  markPreparedGenerationMode(request.chat_id, 'agentic')
  return {
    request: {
      ...request,
      generation_type: target.generationType,
      mode: 'agentic',
      runtime_decision_token: decision.runtimeDecisionToken,
      request_epoch: requestEpoch,
    },
    commitOneTurnSelection: explicitMode === null
      ? () => undefined
      : () => completeOneTurnSelection(request.chat_id, selection),
  }
}

export function resetAgentRuntimeSelectionForTests(): void {
  snapshots.clear()
  listeners.clear()
  requestEpochs.clear()
  displayEpochs.clear()
  pendingRequestEpochs.clear()
  decisionTokens.clear()
  runtimeAuthorityRevision = 0
  runtimeAuthorityListeners.clear()
}
