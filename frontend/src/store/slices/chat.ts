import type { StateCreator } from 'zustand'
import type { ChatSlice, GenerationRequestAuthority } from '@/types/store'
import type { Message, AgentSummary } from '@/types/api'
import type {
  AgentActivityGeneration,
  AgentActivityInvocation,
  AgentActivityPayload,
  AgentActivityActor,
  AgentActivityPhase,
  AgentActivityToolName,
  AgentInvocationStatus,
} from '@/types/ws-events'
import type {
  AgentActivityNodeV1,
  AgentActivityRunV1,
  AgentActivitySnapshotV1,
  AgentActivityLifecycle,
  AgentPublicErrorCode,
  AgentPublicErrorV1,
} from '@/types/agent-runtime'
import { settingsApi } from '@/api/settings'
import { reconcileMessageTail } from '@/store/messageTailReconciliation'

export const AGENT_ACTIVITY_EVENT_LIMIT = 128
export const AGENT_ACTIVITY_BYTES_LIMIT = 64 * 1024
const GENERATION_AUTHORITY_HISTORY_LIMIT = 32

function boundedGenerationHistory(values: readonly string[], next?: string | null): string[] {
  const result = next && !values.includes(next) ? [...values, next] : [...values]
  return result.length > GENERATION_AUTHORITY_HISTORY_LIMIT
    ? result.slice(result.length - GENERATION_AUTHORITY_HISTORY_LIMIT)
    : result
}

function liveGenerationRequest(status: GenerationRequestAuthority['status']): boolean {
  return status === 'pending' || status === 'queued' || status === 'working'
}

const AGENT_ACTIVITY_PHASES: Record<AgentActivityPhase, true> = {
  queued: true, started: true, tool_call: true, completed: true, failed: true, cancelled: true, timed_out: true,
}
const AGENT_ACTIVITY_ACTORS: Record<AgentActivityActor, true> = { main_model: true, child_profile: true }
const AGENT_INVOCATION_STATUSES: Record<AgentInvocationStatus, true> = {
  pending: true, running: true, succeeded: true, failed: true, cancelled: true, timed_out: true,
}
const AGENT_ACTIVITY_TOOL_NAMES: Record<Exclude<AgentActivityToolName, 'unknown_tool'>, true> = {
  lore_list_books: true, lore_get_book: true, lore_list_entries: true, lore_get_entry: true,
  lore_search_entries: true, chat_search_history: true, agent_delegate: true,
  workspace_read_section: true, workspace_read_page: true, workspace_create_task: true,
  workspace_update_progress: true, workspace_submit_result: true, workspace_submit_root_result: true, workspace_accept_submission: true,
  workspace_record_finding: true, workspace_record_decision: true, workspace_record_question: true,
  workspace_attach_artifact: true, workspace_propose_publication: true,
  complete_turn: true,
}
const AGENT_PUBLIC_ERROR_CODES: Record<AgentPublicErrorCode, true> = {
  capacity_exceeded: true, host_child_admission_limit_exceeded: true, host_tool_call_limit_exceeded: true,
  child_admission_limit_exceeded: true, tool_call_limit_exceeded: true,
  logical_provider_request_limit_exceeded: true, physical_dispatch_attempt_limit_exceeded: true,
  child_output_token_limit_exceeded: true, root_wall_clock_limit_exceeded: true,
  activity_event_limit_exceeded: true, activity_byte_limit_exceeded: true,
  lifecycle_log_record_limit_exceeded: true, context_limit_exceeded: true,
  initial_input_limit_exceeded: true, argument_limit_exceeded: true, result_limit_exceeded: true,
  continuation_limit_exceeded: true, retained_output_limit_exceeded: true, materialized_limit_exceeded: true,
  timeout: true, cancelled: true, provider_unavailable: true, provider_unsupported: true,
  provider_tool_calling_unsupported: true, provider_tool_continuation_unsupported: true,
  provider_tool_finalization_unsupported: true,
  provider_request_error: true, provider_protocol_error: true, provider_schema_error: true,
  invalid_task: true, invalid_profile: true, invalid_arguments: true, batch_rejected: true,
  unknown_tool: true, unauthorized: true, integrity_error: true, internal_error: true,
  child_required_failed: true, child_output_limit_exceeded: true, agentic_protocol_failure: true,
}
const AGENT_ACTIVITY_LIFECYCLES: Record<AgentActivityLifecycle, true> = {
  queued: true, running: true, completed: true, failed: true, cancelled: true, timed_out: true,
}
const AGENT_ACTIVITY_NODE_KINDS: Record<AgentActivityNodeV1['kind'], true> = {
  root_turn: true, provider_round: true, child_invocation: true, tool_attempt: true,
}
const AGENT_ACTIVITY_NODE_ACTORS: Record<AgentActivityNodeV1['actor'], true> = {
  root: true, provider: true, child: true, tool: true,
}
const AGENT_ACTIVITY_NODE_TOOL_IDS: Record<Exclude<NonNullable<AgentActivityNodeV1['toolId']>, 'unknown_tool'>, true> = {
  lore_list_books: true, lore_get_book: true, lore_list_entries: true, lore_get_entry: true,
  lore_search_entries: true, chat_search_history: true, agent_delegate: true,
  workspace_read_section: true, workspace_read_page: true, workspace_create_task: true,
  workspace_update_progress: true, workspace_submit_result: true, workspace_submit_root_result: true, workspace_accept_submission: true,
  workspace_record_finding: true, workspace_record_decision: true, workspace_record_question: true,
  workspace_attach_artifact: true, workspace_propose_publication: true,
  complete_turn: true,
}
const AGENT_PUBLIC_ERROR_CATEGORIES: Record<string, true> = {
  capacity: true, budget: true, context: true, integrity: true, timeout: true,
  cancelled: true, provider: true, validation: true, internal: true,
}
const AGENT_PROVIDER_ADAPTERS: Record<string, true> = {
  openai_chat_completions: true, openai_responses: true, openai_compatible_chat_completions: true,
  anthropic_messages: true, google_generative_language: true, google_vertex: true, unknown: true,
}
const AGENT_PUBLIC_BUDGET_IDS: Record<string, true> = {
  child_admissions: true, aggregate_tool_calls: true, logical_provider_requests: true,
  physical_dispatch_attempts: true, child_output_tokens: true, root_wall_clock_ms: true,
  activity_events: true, activity_bytes: true, lifecycle_log_records: true,
  initial_input_bytes: true, argument_bytes: true, result_bytes: true, continuation_bytes: true,
  retained_output_bytes: true, materialized_bytes: true, context_tokens: true,
  active_roots_per_user: true, active_roots_process: true, provider_dispatches_per_user: true,
  provider_dispatches_process: true, tool_executions_per_user: true, tool_executions_process: true,
}

function isAgentActivityPhase(value: unknown): value is AgentActivityPhase {
  return typeof value === 'string' && Object.hasOwn(AGENT_ACTIVITY_PHASES, value)
}
function isAgentActivityActor(value: unknown): value is AgentActivityActor {
  return typeof value === 'string' && Object.hasOwn(AGENT_ACTIVITY_ACTORS, value)
}
function isAgentInvocationStatus(value: unknown): value is AgentInvocationStatus {
  return typeof value === 'string' && Object.hasOwn(AGENT_INVOCATION_STATUSES, value)
}
function isAgentActivityToolName(value: unknown): value is Exclude<AgentActivityToolName, 'unknown_tool'> {
  return typeof value === 'string' && Object.hasOwn(AGENT_ACTIVITY_TOOL_NAMES, value)
}
function isAgentPublicErrorCode(value: unknown): value is AgentPublicErrorCode {
  return typeof value === 'string' && Object.hasOwn(AGENT_PUBLIC_ERROR_CODES, value)
}
function isAgentActivityLifecycle(value: unknown): value is AgentActivityLifecycle {
  return typeof value === 'string' && Object.hasOwn(AGENT_ACTIVITY_LIFECYCLES, value)
}
export function normalizeAgentPublicError(value: unknown): AgentPublicErrorV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const version = readOwnDataProperty(source, 'version')
  const code = readOwnDataProperty(source, 'code')
  const category = readOwnDataProperty(source, 'category')
  const retryable = readOwnDataProperty(source, 'retryable')
  if (
    version !== 1 || !isAgentPublicErrorCode(code)
    || typeof category !== 'string' || !Object.hasOwn(AGENT_PUBLIC_ERROR_CATEGORIES, category)
    || typeof retryable !== 'boolean'
  ) return null
  const adapter = readOwnDataProperty(source, 'adapter')
  if (adapter !== undefined && (typeof adapter !== 'string' || !Object.hasOwn(AGENT_PROVIDER_ADAPTERS, adapter))) return null
  const httpStatus = readOwnDataProperty(source, 'httpStatus')
  if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || (httpStatus as number) < 100 || (httpStatus as number) > 599)) return null
  const providerCode = readOwnDataProperty(source, 'providerCode')
  if (providerCode !== undefined && (typeof providerCode !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(providerCode))) return null
  const rawBudget = readOwnDataProperty(source, 'budget')
  let budget: AgentPublicErrorV1['budget']
  if (rawBudget !== undefined) {
    if (rawBudget === null || typeof rawBudget !== 'object' || Array.isArray(rawBudget)) return null
    const budgetId = readOwnDataProperty(rawBudget, 'id')
    const limit = readOwnDataProperty(rawBudget, 'limit')
    const observed = readOwnDataProperty(rawBudget, 'observed')
    if (
      typeof budgetId !== 'string' || !Object.hasOwn(AGENT_PUBLIC_BUDGET_IDS, budgetId)
      || !Number.isSafeInteger(limit) || (limit as number) < 0
      || !Number.isSafeInteger(observed) || (observed as number) < 0
    ) return null
    budget = {
      id: budgetId as NonNullable<AgentPublicErrorV1['budget']>['id'],
      limit: limit as number,
      observed: observed as number,
    }
  }
  return {
    version: 1,
    code,
    category: category as AgentPublicErrorV1['category'],
    ...(budget ? { budget } : {}),
    ...(adapter !== undefined ? { adapter: adapter as AgentPublicErrorV1['adapter'] } : {}),
    ...(providerCode !== undefined ? { providerCode: providerCode as string } : {}),
    retryable,
  }
}
function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function readSafeId(value: unknown, optional = false): string | undefined | null {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}
function readSafeLabel(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 96 || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

function readAgentUsage(value: unknown): AgentActivityPayload['usage'] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const inputTokens = readNonNegativeNumber(readOwnDataProperty(value, 'inputTokens'))
  const outputTokens = readNonNegativeNumber(readOwnDataProperty(value, 'outputTokens'))
  const totalTokens = readNonNegativeNumber(readOwnDataProperty(value, 'totalTokens'))
  const rawToolCalls = readOwnDataProperty(value, 'toolCalls')
  const rawChildInvocations = readOwnDataProperty(value, 'childInvocations')
  const toolCalls = rawToolCalls === undefined ? undefined : readNonNegativeInteger(rawToolCalls)
  const childInvocations = rawChildInvocations === undefined ? undefined : readNonNegativeInteger(rawChildInvocations)
  if (
    inputTokens === null || outputTokens === null || totalTokens === null
    || toolCalls === null || childInvocations === null
  ) return null
  return {
    inputTokens, outputTokens, totalTokens,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(childInvocations !== undefined ? { childInvocations } : {}),
  }
}

/** Composite key keeps concurrent roots and swipe targets separate. */
export function agentActivityGenerationKey(generationId: string, messageId?: string, swipeId?: number): string {
  return `${generationId}\u0000${messageId ?? ''}\u0000${swipeId == null ? '' : String(swipeId)}`
}

export function normalizeAgentActivityPayload(value: unknown): AgentActivityPayload | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const generationId = readSafeId(readOwnDataProperty(value, 'generationId'))
  const chatId = readSafeId(readOwnDataProperty(value, 'chatId'), true)
  const messageId = readSafeId(readOwnDataProperty(value, 'messageId'), true)
  const invocationId = readSafeId(readOwnDataProperty(value, 'invocationId'))
  const parentInvocationId = readSafeId(readOwnDataProperty(value, 'parentInvocationId'), true)
  const actor = readOwnDataProperty(value, 'actor')
  const profileName = readSafeLabel(readOwnDataProperty(value, 'profileName'))
  const phase = readOwnDataProperty(value, 'phase')
  const status = readOwnDataProperty(value, 'status')
  const rawErrorCode = readOwnDataProperty(value, 'errorCode')
  const rawToolName = readOwnDataProperty(value, 'toolName')
  const rawUsage = readOwnDataProperty(value, 'usage')
  const startedAt = readNonNegativeNumber(readOwnDataProperty(value, 'startedAt'))
  const elapsedMs = readNonNegativeNumber(readOwnDataProperty(value, 'elapsedMs'))
  const rawSwipeId = readOwnDataProperty(value, 'swipeId')
  const targetSwipeId = readOwnDataProperty(value, 'targetSwipeId')
  const rawRoundIndex = readOwnDataProperty(value, 'roundIndex')
  const rawContinuationMode = readOwnDataProperty(value, 'continuationMode')
  const swipeId = rawSwipeId === undefined ? targetSwipeId : rawSwipeId
  const roundIndex = rawRoundIndex === undefined ? undefined : readNonNegativeInteger(rawRoundIndex)
  const continuationMode =
    rawContinuationMode === undefined || rawContinuationMode === 'ordinary'
      || rawContinuationMode === 'finalization' || rawContinuationMode === 'none'
      ? rawContinuationMode as AgentActivityPayload['continuationMode'] | undefined
      : null
  if (
    generationId === null || invocationId === null || chatId === null || messageId === null
    || parentInvocationId === null || profileName === null
    || !isAgentActivityActor(actor) || (actor === 'child_profile' && profileName === undefined)
    || !isAgentActivityPhase(phase) || !isInvocationStatus(status)
    || startedAt === null || elapsedMs === null
    || (swipeId !== undefined && (typeof swipeId !== 'number' || !Number.isSafeInteger(swipeId) || swipeId < 0))
    || (rawRoundIndex !== undefined && roundIndex === null)
    || continuationMode === null
  ) return null
  const toolName = rawToolName === undefined ? undefined : isAgentActivityToolName(rawToolName) ? rawToolName : null
  if (toolName === null) return null
  const usage = rawUsage === undefined ? undefined : readAgentUsage(rawUsage)
  if (rawUsage !== undefined && usage === null) return null
  return {
    generationId,
    ...(chatId !== undefined ? { chatId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(swipeId !== undefined ? { swipeId: swipeId as number } : {}),
    invocationId,
    ...(parentInvocationId !== undefined ? { parentInvocationId } : {}),
    actor,
    ...(profileName !== undefined ? { profileName } : {}),
    phase,
    status,
    ...(isAgentPublicErrorCode(rawErrorCode) ? { errorCode: rawErrorCode } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    startedAt,
    elapsedMs,
    ...(roundIndex !== undefined ? { roundIndex } : {}),
    ...(continuationMode !== undefined ? { continuationMode } : {}),
    ...(usage ? { usage } : {}),
  }
}

function activityPayloadBytes(payload: AgentActivityPayload): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength
  } catch {
    return AGENT_ACTIVITY_BYTES_LIMIT
  }
}

export function reconcileAgentActivityState(
  state: Record<string, AgentActivityGeneration>,
  value: unknown,
): Record<string, AgentActivityGeneration> {
  const payload = normalizeAgentActivityPayload(value)
  if (!payload) return state
  const key = agentActivityGenerationKey(payload.generationId, payload.messageId, payload.swipeId)
  const generation = state[key] ?? {
    invocationOrder: [], invocations: {}, generationId: payload.generationId,
    ...(payload.chatId ? { chatId: payload.chatId } : {}),
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
    ...(payload.swipeId !== undefined ? { swipeId: payload.swipeId } : {}),
    eventCount: 0, eventBytes: 0, omittedNodeCount: 0, errorCounts: {},
  }
  const eventBytes = activityPayloadBytes(payload)
  const nextEventCount = (generation.eventCount ?? 0) + 1
  if (nextEventCount > AGENT_ACTIVITY_EVENT_LIMIT || (generation.eventBytes ?? 0) + eventBytes > AGENT_ACTIVITY_BYTES_LIMIT) {
    return {
      ...state,
      [key]: {
        ...generation,
        omittedNodeCount: (generation.omittedNodeCount ?? 0) + 1,
        errorCounts: payload.errorCode
          ? { ...generation.errorCounts, [payload.errorCode]: (generation.errorCounts?.[payload.errorCode] ?? 0) + 1 }
          : generation.errorCounts,
      },
    }
  }
  const previous = generation.invocations[payload.invocationId]
  const invocation: AgentActivityInvocation = {
    invocationId: payload.invocationId,
    ...(payload.parentInvocationId !== undefined || previous?.parentInvocationId !== undefined
      ? { parentInvocationId: payload.parentInvocationId ?? previous?.parentInvocationId }
      : {}),
    actor: payload.actor,
    ...(payload.profileName !== undefined ? { profileName: payload.profileName } : {}),
    phase: payload.phase,
    status: payload.status,
    ...(payload.toolName ?? previous?.toolName ? { toolName: payload.toolName ?? previous?.toolName } : {}),
    startedAt: payload.startedAt,
    elapsedMs: payload.elapsedMs,
    ...(payload.roundIndex !== undefined ? { roundIndex: payload.roundIndex } : {}),
    ...(payload.continuationMode !== undefined ? { continuationMode: payload.continuationMode } : {}),
    ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
    ...(payload.usage ?? previous?.usage ? { usage: payload.usage ?? previous?.usage } : {}),
  }
  return {
    ...state,
    [key]: {
      ...generation,
      invocationOrder: previous ? generation.invocationOrder : [...generation.invocationOrder, payload.invocationId],
      invocations: { ...generation.invocations, [payload.invocationId]: invocation },
      eventCount: nextEventCount,
      eventBytes: (generation.eventBytes ?? 0) + eventBytes,
      status: payload.status,
      usage: payload.usage ?? generation.usage,
      ...(payload.errorCode
        ? { errorCounts: { ...generation.errorCounts, [payload.errorCode]: (generation.errorCounts?.[payload.errorCode] ?? 0) + 1 } }
        : {}),
    },
  }
}

function cleanActivityUsage(value: unknown): AgentActivitySnapshotV1['usage'] | null {
  const usage = readAgentUsage(value)
  if (!usage) return null
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    toolCalls: usage.toolCalls ?? 0,
    childInvocations: usage.childInvocations ?? 0,
  }
}

function normalizeActivityNode(value: unknown): AgentActivityNodeV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = readSafeId(readOwnDataProperty(source, 'id'))
  const rawParentId = readOwnDataProperty(source, 'parentId')
  const parentId = rawParentId === null ? null : readSafeId(rawParentId)
  const kind = readOwnDataProperty(source, 'kind')
  const actor = readOwnDataProperty(source, 'actor')
  const phase = readOwnDataProperty(source, 'phase')
  const status = readOwnDataProperty(source, 'status')
  const startedAt = readNonNegativeInteger(readOwnDataProperty(source, 'startedAt'))
  const elapsedMs = readNonNegativeInteger(readOwnDataProperty(source, 'elapsedMs'))
  const rawProfileId = readOwnDataProperty(source, 'profileId')
  const profileId = rawProfileId === undefined ? undefined : readSafeId(rawProfileId)
  const rawToolId = readOwnDataProperty(source, 'toolId')
  const toolId = rawToolId === undefined
    ? undefined
    : typeof rawToolId === 'string' && Object.hasOwn(AGENT_ACTIVITY_NODE_TOOL_IDS, rawToolId)
      ? rawToolId as AgentActivityNodeV1['toolId']
      : null
  const rawRoundIndex = readOwnDataProperty(source, 'roundIndex')
  const roundIndex = rawRoundIndex === undefined ? undefined : readNonNegativeInteger(rawRoundIndex)
  const rawContinuationMode = readOwnDataProperty(source, 'continuationMode')
  const continuationMode =
    rawContinuationMode === undefined || rawContinuationMode === 'ordinary'
      || rawContinuationMode === 'finalization' || rawContinuationMode === 'none'
      ? rawContinuationMode as AgentActivityNodeV1['continuationMode']
      : null
  const rawErrorCode = readOwnDataProperty(source, 'errorCode')
  const errorCode = isAgentPublicErrorCode(rawErrorCode) ? rawErrorCode : undefined
  const rawUsage = readOwnDataProperty(source, 'usage')
  const usage = rawUsage === undefined ? undefined : cleanActivityUsage(rawUsage)
  if (
    id === null || parentId === undefined || parentId === null && rawParentId !== null
    || !isAgentActivityLifecycle(phase) || !isAgentActivityLifecycle(status)
    || typeof kind !== 'string' || !Object.hasOwn(AGENT_ACTIVITY_NODE_KINDS, kind)
    || typeof actor !== 'string' || !Object.hasOwn(AGENT_ACTIVITY_NODE_ACTORS, actor)
    || startedAt === null || elapsedMs === null
    || profileId === null || toolId === null || roundIndex === null
    || continuationMode === null
    || (rawUsage !== undefined && usage === null)
  ) return null
  return {
    id,
    parentId,
    kind: kind as AgentActivityNodeV1['kind'],
    actor: actor as AgentActivityNodeV1['actor'],
    ...(profileId !== undefined ? { profileId } : {}),
    ...(toolId !== undefined ? { toolId } : {}),
    phase,
    status,
    ...(roundIndex !== undefined ? { roundIndex } : {}),
    ...(continuationMode !== undefined ? { continuationMode } : {}),
    startedAt,
    elapsedMs,
    ...(usage ? { usage } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

export function normalizeActivityRun(value: unknown): AgentActivityRunV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const version = readOwnDataProperty(source, 'version')
  const generationId = readSafeId(readOwnDataProperty(source, 'generationId'))
  const chatId = readSafeId(readOwnDataProperty(source, 'chatId'))
  const targetMessageId = readOwnDataProperty(source, 'targetMessageId')
  const targetSwipeId = readOwnDataProperty(source, 'targetSwipeId')
  const snapshot = readOwnDataProperty(source, 'snapshot')
  const normalizedTargetMessageId =
    targetMessageId === null ? null : readSafeId(targetMessageId)
  if (
    version !== 1 || generationId === null || chatId === null
    || (targetMessageId !== null && normalizedTargetMessageId === null)
    || (targetSwipeId !== null && (!Number.isSafeInteger(targetSwipeId) || (targetSwipeId as number) < 0))
    || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
  ) return null
  const snap = snapshot as Record<string, unknown>
  const status = readOwnDataProperty(snap, 'status')
  const rootId = readSafeId(readOwnDataProperty(snap, 'rootId'))
  const sourceOmittedNodeCount = readNonNegativeInteger(readOwnDataProperty(snap, 'omittedNodeCount'))
  const usage = cleanActivityUsage(readOwnDataProperty(snap, 'usage'))
  const rawNodes = readOwnDataProperty(snap, 'nodes')
  if (
    !isAgentActivityLifecycle(status) || rootId === null
    || sourceOmittedNodeCount === null || !usage || !Array.isArray(rawNodes)
  ) return null
  const normalizedNodes = rawNodes.map(normalizeActivityNode)
  const nodes = normalizedNodes.filter((node): node is AgentActivityNodeV1 => node !== null)
  if (nodes.length !== normalizedNodes.length) return null
  let omittedNodeCount = sourceOmittedNodeCount
  let nodeBytes = 0
  const boundedNodes: AgentActivityNodeV1[] = []
  for (const node of nodes) {
    if (boundedNodes.length >= AGENT_ACTIVITY_EVENT_LIMIT) {
      omittedNodeCount += 1
      continue
    }
    const bytes = new TextEncoder().encode(JSON.stringify(node)).byteLength
    if (nodeBytes + bytes > AGENT_ACTIVITY_BYTES_LIMIT) {
      omittedNodeCount += 1
      continue
    }
    boundedNodes.push(node)
    nodeBytes += bytes
  }
  const rawErrors = readOwnDataProperty(snap, 'errorCounts')
  const errorCounts: Partial<Record<AgentPublicErrorCode, number>> = {}
  if (rawErrors && typeof rawErrors === 'object' && !Array.isArray(rawErrors)) {
    for (const [code, count] of Object.entries(rawErrors)) {
      if (isAgentPublicErrorCode(code) && Number.isSafeInteger(count) && count >= 0) {
        errorCounts[code] = count
      }
    }
  }
  const rawTerminalErrorCode = readOwnDataProperty(snap, 'terminalErrorCode')
  const terminalErrorCode: AgentPublicErrorCode | undefined =
    rawTerminalErrorCode === undefined
      ? undefined
      : isAgentPublicErrorCode(rawTerminalErrorCode)
        ? rawTerminalErrorCode
        : undefined
  return {
    version: 1,
    generationId,
    chatId,
    targetMessageId: normalizedTargetMessageId,
    targetSwipeId: targetSwipeId === null ? null : targetSwipeId as number,
    snapshot: {
      version: 1,
      rootId,
      nodes: boundedNodes,
      omittedNodeCount,
      errorCounts,
      usage,
      status,
      ...(terminalErrorCode !== undefined ? { terminalErrorCode } : {}),
    },
  }
}

export function mergeAgentActivityRuns(
  state: Record<string, AgentActivityRunV1>,
  values: unknown[],
): Record<string, AgentActivityRunV1> {
  const next = { ...state }
  for (const value of values) {
    const run = normalizeActivityRun(value)
    if (run) next[run.generationId] = run
  }
  return next
}
export function activityGenerationFromRun(run: AgentActivityRunV1): AgentActivityGeneration {
  const invocations: AgentActivityGeneration['invocations'] = {}
  const invocationOrder: string[] = []
  for (const node of run.snapshot.nodes) {
    const actor = node.actor === 'root' || node.actor === 'provider' ? 'main_model' : 'child_profile'
    const phase: AgentActivityPhase =
      node.phase === 'queued' ? 'queued'
        : node.phase === 'running' ? 'started'
          : node.phase === 'completed' ? 'completed'
            : node.phase === 'cancelled' ? 'cancelled'
              : node.phase === 'timed_out' ? 'timed_out'
                : node.kind === 'tool_attempt' ? 'tool_call' : 'failed'
    const status: AgentInvocationStatus =
      node.status === 'queued' ? 'pending'
        : node.status === 'running' ? 'running'
          : node.status === 'completed' ? 'succeeded'
            : node.status === 'cancelled' ? 'cancelled'
              : node.status === 'timed_out' ? 'timed_out' : 'failed'
    const invocationId = node.id
    if (invocations[invocationId]) continue
    invocations[invocationId] = {
      invocationId,
      ...(node.parentId ? { parentInvocationId: node.parentId } : {}),
      actor,
      ...(node.profileId ? { profileName: node.profileId } : {}),
      phase,
      status,
      ...(node.toolId && node.toolId !== 'unknown_tool' ? { toolName: node.toolId } : {}),
      startedAt: node.startedAt,
      elapsedMs: node.elapsedMs,
      ...(node.roundIndex !== undefined ? { roundIndex: node.roundIndex } : {}),
      ...(node.continuationMode ? { continuationMode: node.continuationMode } : {}),
      ...(node.errorCode ? { errorCode: node.errorCode } : {}),
      ...(node.usage
        ? {
            usage: {
              inputTokens: node.usage.inputTokens,
              outputTokens: node.usage.outputTokens,
              totalTokens: node.usage.totalTokens,
              toolCalls: node.usage.toolCalls,
              childInvocations: node.usage.childInvocations,
            },
          }
        : {}),
    }
    invocationOrder.push(invocationId)
  }
  const generationStatus: AgentActivityGeneration['status'] =
    run.snapshot.status === 'queued' ? 'pending'
      : run.snapshot.status === 'running' ? 'running'
        : run.snapshot.status === 'completed' ? 'succeeded'
          : run.snapshot.status
  return {
    invocationOrder,
    invocations,
    generationId: run.generationId,
    chatId: run.chatId,
    ...(run.targetMessageId ? { messageId: run.targetMessageId } : {}),
    ...(run.targetSwipeId !== null ? { swipeId: run.targetSwipeId } : {}),
    omittedNodeCount: run.snapshot.omittedNodeCount,
    errorCounts: run.snapshot.errorCounts,
    status: generationStatus,
    ...(run.snapshot.terminalErrorCode ? { terminalErrorCode: run.snapshot.terminalErrorCode } : {}),
    usage: run.snapshot.usage,
  }
}

export function agentSummaryFromRun(run: AgentActivityRunV1): AgentSummary {
  const statuses = run.snapshot.nodes.map((node) => node.status)
  const countStatus = (wanted: AgentActivityLifecycle) => statuses.reduce(
    (count, value) => count + (value === wanted ? 1 : 0),
    0,
  )
  const succeededCount = countStatus('completed')
  const failedCount = countStatus('failed')
  const cancelledCount = countStatus('cancelled')
  const timedOutCount = countStatus('timed_out')
  const summaryStatus: AgentSummary['status'] =
    run.snapshot.status === 'completed' ? 'succeeded'
      : run.snapshot.status === 'cancelled' ? 'cancelled'
        : run.snapshot.status === 'timed_out' ? 'timed_out' : run.snapshot.status === 'failed' ? 'failed' : 'succeeded'
  return {
    status: summaryStatus,
    invocationCount: Math.max(statuses.length, run.snapshot.usage.childInvocations),
    succeededCount,
    failedCount,
    cancelledCount,
    timedOutCount,
    toolCallCount: run.snapshot.usage.toolCalls,
    usage: {
      inputTokens: run.snapshot.usage.inputTokens,
      outputTokens: run.snapshot.usage.outputTokens,
      totalTokens: run.snapshot.usage.totalTokens,
    },
    ...(Object.keys(run.snapshot.errorCounts).length > 0
      ? { errorCodes: Object.keys(run.snapshot.errorCounts) }
      : {}),
  }
}


function retainAgentActivityGeneration(
  state: Record<string, AgentActivityGeneration>,
  generationId: string,
): Record<string, AgentActivityGeneration> {
  const retained: Record<string, AgentActivityGeneration> = {}
  for (const [key, activity] of Object.entries(state)) {
    if (activity.generationId === generationId || key.startsWith(`${generationId}\u0000`)) retained[key] = activity
  }
  return retained
}

function isInvocationStatus(value: unknown): value is AgentInvocationStatus {
  return typeof value === 'string' && Object.hasOwn(AGENT_INVOCATION_STATUSES, value)
}


export const createChatSlice: StateCreator<ChatSlice> = (set, get) => {
  const LOCAL_STREAM_PLACEHOLDER_PREFIX = '__stream_placeholder_'
  const LOCAL_REGEN_PLACEHOLDER_PREFIX = '__regen_placeholder_'

  // Tracks recently ended generation IDs, so that a late `startStreaming()`
  // call (e.g. from an HTTP response arriving after the WS GENERATION_ENDED
  // event in sidecar-council mode) doesn't restart a zombie streaming state.
  // We track a small set rather than a single ID because during rapid
  // stop→regenerate cycles, multiple generations may end in quick succession.
  const endedGenerationIds = new Set<string>()

  // ── Throttled streaming buffers ──────────────────────────────────────
  // Tokens accumulate here at full WS throughput (no React re-renders).
  // A timer flushes to Zustand at a capped rate (~30fps), so expensive
  // downstream rendering (markdown, OOC parsing, DOM walks) runs at most
  // once per interval instead of per-token. 32ms ≈ 30fps — smooth enough
  // for text streaming while halving render overhead vs. RAF at 60fps.
  let rawStreamContent = ''
  let rawStreamReasoning = ''
  let reasoningStartedAt = 0
  let streamFlushTimer = 0
  let lastFlushTime = 0
  const STREAM_FLUSH_INTERVAL = 32

  function scheduleStreamFlush() {
    if (streamFlushTimer) return
    const elapsed = performance.now() - lastFlushTime
    const delay = Math.max(0, STREAM_FLUSH_INTERVAL - elapsed)
    streamFlushTimer = window.setTimeout(() => {
      streamFlushTimer = 0
      lastFlushTime = performance.now()
      set({
        streamingContent: rawStreamContent,
        streamingReasoning: rawStreamReasoning,
      })
    }, delay) as unknown as number
  }

  function cancelStreamFlush() {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer)
      streamFlushTimer = 0
    }
  }

  function sortMessagesByPosition(messages: Message[]): Message[] {
    return [...messages].sort((a, b) => {
      if (a.index_in_chat !== b.index_in_chat) return a.index_in_chat - b.index_in_chat
      if (a.send_date !== b.send_date) return a.send_date - b.send_date
      if (a.created_at !== b.created_at) return a.created_at - b.created_at
      return a.id.localeCompare(b.id)
    })
  }

  function isLocalStreamingPlaceholderId(id: string | null | undefined) {
    return !!id && (
      id.startsWith(LOCAL_STREAM_PLACEHOLDER_PREFIX)
      || id.startsWith(LOCAL_REGEN_PLACEHOLDER_PREFIX)
    )
  }

  function shouldUseLocalStreamPlaceholder(generationType: string | null | undefined) {
    return generationType !== 'continue' && generationType !== 'impersonate_draft'
  }

  function createLocalStreamPlaceholder(state: ChatSlice): Message | null {
    if (!state.activeChatId) return null

    const lastMessage = state.messages[state.messages.length - 1]
    const now = Math.floor(Date.now() / 1000)

    return {
      id: `${LOCAL_STREAM_PLACEHOLDER_PREFIX}${Date.now()}`,
      chat_id: state.activeChatId,
      index_in_chat: (lastMessage?.index_in_chat ?? -1) + 1,
      is_user: false,
      name: '',
      content: '',
      send_date: now,
      swipe_id: 0,
      swipes: [''],
      swipe_dates: [now],
      extra: {},
      parent_message_id: null,
      branch_id: null,
      created_at: now,
    }
  }

  return {
    activeChatId: null,
    activeCharacterId: null,
    activeChatDisplayOwner: null,
    activeChatName: null,
    activeChatWallpaper: null,
    activeChatAvatarId: null,
    activeChatMetadata: null,
    messages: [],
    generationRequests: {},
    isStreaming: false,
    streamingNavigationPaused: false,
    streamingContent: '',
    streamingReasoning: '',
    streamingReasoningDuration: null,
    streamingReasoningStartedAt: null,
    streamingError: null,
    lastGenerationTerminalStatus: null,
    lastGenerationProvider: null,
    lastGenerationConnectionLabel: null,
    lastGenerationModel: null,
    activeGenerationId: null,
    agentActivityByGeneration: {},
    agentActivityRunsByGeneration: {},
    agentTerminalErrorsByGeneration: {},
    regeneratingMessageId: null,
    streamingSwipeId: null,
    streamingGenerationType: null,
    lastCompletedGenerationType: null,
    unseenSwipes: {},
    totalChatLength: 0,
    impersonateDraftContent: null,
    landingRecentChats: null,

    setLandingRecentChats: (result) => set({ landingRecentChats: result }),
    setGenerationProviderMetadata: (metadata) => set((state) => ({
      lastGenerationProvider: metadata.provider === undefined ? state.lastGenerationProvider : metadata.provider,
      lastGenerationConnectionLabel: metadata.connectionLabel === undefined ? state.lastGenerationConnectionLabel : metadata.connectionLabel,
      lastGenerationModel: metadata.model === undefined ? state.lastGenerationModel : metadata.model,
    })),

    setActiveChat: (chatId, characterId = null, hydration) => {
      // A throttled token flush can still be queued when ChatView unmounts.
      // Cancel it and clear the closure-owned buffers before resetting the
      // public state; otherwise that timer can fire on the landing page and
      // restore streaming content for a chat that is no longer active.
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      endedGenerationIds.clear()
      const metadata = hydration?.metadata ?? null
      const groupAvatar = metadata?.group === true && characterId
        ? metadata.group_active_avatar_ids?.[characterId]
        : undefined
      const avatarId = typeof groupAvatar === 'string'
        ? groupAvatar
        : metadata?.group === true
          ? null
          : typeof metadata?.active_avatar_id === 'string'
            ? metadata.active_avatar_id
            : null
      set({
        activeChatId: chatId,
        activeCharacterId: characterId,
        activeChatDisplayOwner: hydration?.displayOwner ?? null,
        activeChatName: hydration?.name ?? null,
        activeChatWallpaper: hydration?.wallpaper ?? null,
        activeChatAvatarId: avatarId,
        activeChatMetadata: metadata,
        messages: hydration?.messages ?? [],
        isStreaming: false,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        lastGenerationTerminalStatus: null,
        lastGenerationProvider: null,
        lastGenerationConnectionLabel: null,
        lastGenerationModel: null,
        activeGenerationId: null,
        agentActivityByGeneration: {},
        agentActivityRunsByGeneration: {},
        agentTerminalErrorsByGeneration: {},
        streamingSwipeId: null,
        streamingGenerationType: null,
        unseenSwipes: {},
        totalChatLength: hydration?.total ?? 0,
        messageSelectMode: false,
        selectedMessageIds: [],
      })
      // Clear expression state so stale expressions from the previous character don't linger
      ;(get() as any).setActiveExpression?.(null, null, null)
      // Clear lore activation state so entries from the previous chat are not shown
      // while the new chat waits for its first generation event.
      ;(get() as any).clearActivatedWorldInfo?.()
      // Clear any pending message edit from the previous chat
      ;(get() as any).setEditingMessageId?.(null)
      settingsApi.put('activeChatId', chatId).catch(() => {})
    },

    setActiveChatWallpaper: (wallpaper) => set({ activeChatWallpaper: wallpaper }),

    setActiveChatAvatarId: (imageId) => set({ activeChatAvatarId: imageId }),

    setActiveChatMetadata: (metadata) => set((state) => {
      const groupAvatar = metadata?.group === true && state.activeCharacterId
        ? metadata.group_active_avatar_ids?.[state.activeCharacterId]
        : undefined
      const avatarId = typeof groupAvatar === 'string'
        ? groupAvatar
        : metadata?.group === true
          ? null
          : typeof metadata?.active_avatar_id === 'string'
            ? metadata.active_avatar_id
            : null
      return { activeChatMetadata: metadata, activeChatAvatarId: avatarId }
    }),

    setActiveChatDisplayOwner: (owner) => set({ activeChatDisplayOwner: owner }),

    setActiveChatName: (name) => set({ activeChatName: name }),

    setMessages: (messages, total?) =>
      set((state) => {
        let nextMessages = messages

        // A list request can begin just before a swipe is staged and resolve
        // just after its MESSAGE_SWIPED event. Do not let that older snapshot
        // erase the streaming target; the final reconciliation will replace it
        // once the server response contains that swipe slot.
        if (
          state.isStreaming &&
          state.streamingGenerationType === 'swipe' &&
          state.regeneratingMessageId &&
          state.streamingSwipeId != null
        ) {
          const current = state.messages.find((message) => message.id === state.regeneratingMessageId)
          const incomingIndex = nextMessages.findIndex((message) => message.id === state.regeneratingMessageId)
          if (
            current &&
            incomingIndex >= 0 &&
            nextMessages[incomingIndex].swipes.length <= state.streamingSwipeId
          ) {
            nextMessages = [...nextMessages]
            nextMessages[incomingIndex] = current
          }
        }

        return {
          messages: sortMessagesByPosition(nextMessages),
          totalChatLength: total ?? nextMessages.length,
        }
      }),

    reconcileMessagesTail: (page) =>
      set((state) => ({
        messages: sortMessagesByPosition(reconcileMessageTail(
          state.messages,
          state.totalChatLength,
          page,
        )),
        totalChatLength: page.total,
      })),

    prependMessages: (olderMessages) =>
      set((state) => {
        const existingIds = new Set(state.messages.map((m) => m.id))
        const unique = olderMessages.filter((m) => !existingIds.has(m.id))
        if (unique.length === 0) return state
        return { messages: sortMessagesByPosition([...unique, ...state.messages]) }
      }),

    addMessage: (message) =>
      set((state) => {
        const byId = state.messages.findIndex((m) => m.id === message.id)
        if (byId !== -1) {
          const messages = [...state.messages]
          messages[byId] = message
          return { messages: sortMessagesByPosition(messages) }
        }

        const messages = sortMessagesByPosition([...state.messages, message])
        return { messages, totalChatLength: state.totalChatLength + 1 }
      }),

    updateMessage: (id, updates) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = [...state.messages]
        messages[idx] = { ...messages[idx], ...updates }
        return { messages }
      }),

    removeMessage: (id) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = state.messages.filter((_m, i) => i !== idx)
        const unseenSwipes = id in state.unseenSwipes
          ? Object.fromEntries(Object.entries(state.unseenSwipes).filter(([k]) => k !== id))
          : state.unseenSwipes
        return { messages, totalChatLength: Math.max(0, state.totalChatLength - 1), unseenSwipes }
      }),
    beginGenerationRequest: (chatId, intent) => {
      const current = get().generationRequests[chatId]
      current?.abortController?.abort(new DOMException('Superseded generation', 'AbortError'))
      const previousGenerationId = current?.generationId ?? null
      const next: GenerationRequestAuthority = {
        chatId,
        epoch: (current?.epoch ?? 0) + 1,
        requestAuthorityId: intent.requestAuthorityId === undefined
          ? crypto.randomUUID()
          : intent.requestAuthorityId,
        generationId: null,
        abortController: new AbortController(),
        status: 'pending',
        generationType: intent.generationType,
        targetMessageId: intent.targetMessageId ?? null,
        targetSwipeId: intent.targetSwipeId ?? null,
        retiredGenerationIds: boundedGenerationHistory(
          current?.retiredGenerationIds ?? [],
          liveGenerationRequest(current?.status ?? 'completed') ? previousGenerationId : null,
        ),
        terminalGenerationIds: boundedGenerationHistory(
          current?.terminalGenerationIds ?? [],
          previousGenerationId,
        ),
      }
      set((state) => ({
        generationRequests: { ...state.generationRequests, [chatId]: next },
      }))
      return next
    },

    acceptGenerationRequest: (chatId, generationId, requestAuthorityId, status = 'queued') => {
      let accepted = false
      set((state) => {
        const current = state.generationRequests[chatId]
        if (current) {
          if (!liveGenerationRequest(current.status)) return state
          if (current.requestAuthorityId !== null && current.requestAuthorityId !== (requestAuthorityId ?? null)) return state
          if (current.retiredGenerationIds.includes(generationId) || current.terminalGenerationIds.includes(generationId)) return state
          if (current.generationId && current.generationId !== generationId) return state
          accepted = true
          return {
            generationRequests: {
              ...state.generationRequests,
              [chatId]: {
                ...current,
                generationId,
                status: current.status === 'working' ? 'working' : status,
              },
            },
          }
        }
        accepted = true
        return {
          generationRequests: {
            ...state.generationRequests,
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
          },
        }
      })
      return accepted
    },

    settleGenerationRequest: (chatId, status, generationId, requestAuthorityId) => {
      let settled = false
      set((state) => {
        const current = state.generationRequests[chatId]
        if (!current) return state
        if (current.requestAuthorityId !== null && current.requestAuthorityId !== (requestAuthorityId ?? null)) return state
        if (generationId && current.generationId && current.generationId !== generationId) return state
        if (generationId && current.retiredGenerationIds.includes(generationId)) return state
        const canonicalOverridesOptimisticStop = current.status === 'stopped'
          && status !== 'stopped'
          && !!generationId
          && (!current.generationId || current.generationId === generationId)
        if (!liveGenerationRequest(current.status) && !canonicalOverridesOptimisticStop) return state
        settled = true
        const terminalId = generationId ?? current.generationId
        return {
          generationRequests: {
            ...state.generationRequests,
            [chatId]: {
              ...current,
              generationId: terminalId,
              abortController: null,
              status,
              terminalGenerationIds: boundedGenerationHistory(current.terminalGenerationIds, terminalId),
            },
          },
        }
      })
      return settled
    },
    stopGenerationRequest: (chatId) => {
      const current = get().generationRequests[chatId]
      if (!current || !liveGenerationRequest(current.status)) return current ?? null
      current.abortController?.abort(new DOMException('Generation cancelled', 'AbortError'))
      const stopped: GenerationRequestAuthority = {
        ...current,
        abortController: null,
        status: 'stopped',
        terminalGenerationIds: boundedGenerationHistory(current.terminalGenerationIds, current.generationId),
      }
      set((state) => ({
        generationRequests: { ...state.generationRequests, [chatId]: stopped },
      }))
      return stopped
    },
    beginStreaming: (regeneratingMessageId, generationType, options) => {
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0

      const current = get()
      let nextRegeneratingMessageId = regeneratingMessageId ?? null
      let nextMessages = current.messages
      let nextTotalChatLength = current.totalChatLength

      if (
        options?.createPlaceholder !== false
        && !nextRegeneratingMessageId
        && shouldUseLocalStreamPlaceholder(generationType)
      ) {
        const placeholder = createLocalStreamPlaceholder(current)
        if (placeholder) {
          nextRegeneratingMessageId = placeholder.id
          nextMessages = sortMessagesByPosition([...current.messages, placeholder])
          nextTotalChatLength = current.totalChatLength + 1
        }
      }
      set({
        messages: nextMessages,
        totalChatLength: nextTotalChatLength,
        isStreaming: true,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        lastGenerationTerminalStatus: null,
        lastGenerationProvider: null,
        lastGenerationConnectionLabel: null,
        lastGenerationModel: null,
        activeGenerationId: null,
        agentActivityByGeneration: {},
        regeneratingMessageId: nextRegeneratingMessageId,
        streamingSwipeId: null,
        streamingGenerationType: generationType ?? null,
      })
    },

    setRegeneratingMessageId: (messageId) => {
      set({ regeneratingMessageId: messageId })
    },

    startStreaming: (generationId, regeneratingMessageId, generationType) => {
      // Guard: don't restart a generation that already completed (race condition
      // in sidecar-council mode where GENERATION_ENDED arrives before the HTTP
      // response that triggers this call from InputArea).
      if (endedGenerationIds.has(generationId)) return
      // Guard: don't reset content for a generation that's already streaming
      // (WS GENERATION_STARTED may arrive slightly before the HTTP response).
      if (generationId === get().activeGenerationId) return

      const current = get()

      const resolvedGenerationType = generationType ?? current.streamingGenerationType
      const resolvedRegeneratingMessageId = regeneratingMessageId ?? current.regeneratingMessageId

      // If we're already in an optimistic streaming state (beginStreaming was
      // called), just wire up the generation ID without resetting buffers —
      // tokens may have already started arriving via WS.
      if (current.isStreaming && !current.activeGenerationId) {
        set({
          activeGenerationId: generationId,
          agentActivityByGeneration: retainAgentActivityGeneration(current.agentActivityByGeneration, generationId),
          regeneratingMessageId: resolvedRegeneratingMessageId,
          streamingGenerationType: resolvedGenerationType ?? null,
        })
        return
      }

      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0

      let nextRegeneratingMessageId = resolvedRegeneratingMessageId ?? null
      let nextMessages = current.messages
      let nextTotalChatLength = current.totalChatLength

      if (!nextRegeneratingMessageId && shouldUseLocalStreamPlaceholder(resolvedGenerationType)) {
        const placeholder = createLocalStreamPlaceholder(current)
        if (placeholder) {
          nextRegeneratingMessageId = placeholder.id
          nextMessages = sortMessagesByPosition([...current.messages, placeholder])
          nextTotalChatLength = current.totalChatLength + 1
        }
      }
      set({
        messages: nextMessages,
        totalChatLength: nextTotalChatLength,
        isStreaming: true,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        lastGenerationTerminalStatus: null,
        lastGenerationProvider: null,
        lastGenerationConnectionLabel: null,
        lastGenerationModel: null,
        activeGenerationId: generationId,
        agentActivityByGeneration: retainAgentActivityGeneration(current.agentActivityByGeneration, generationId),
        regeneratingMessageId: nextRegeneratingMessageId,
        streamingSwipeId: null,
        streamingGenerationType: resolvedGenerationType ?? null,
      })
    },

    setStreamingSwipeId: (swipeId) => {
      set({ streamingSwipeId: swipeId })
    },

    pauseStreamingForNavigation: () => {
      if (!get().isStreaming) return
      // Commit the newest private-buffer frame, then stop the queued flush.
      // The UI keeps rendering this snapshot through the exit animation while
      // the generation itself continues in the backend/chat head.
      cancelStreamFlush()
      set({
        streamingContent: rawStreamContent,
        streamingReasoning: rawStreamReasoning,
        streamingNavigationPaused: true,
      })
    },

    setUnseenSwipe: (messageId, swipeId) => {
      set((state) => {
        if (state.unseenSwipes[messageId] === swipeId) return state
        return { unseenSwipes: { ...state.unseenSwipes, [messageId]: swipeId } }
      })
    },

    clearUnseenSwipe: (messageId) => {
      set((state) => {
        if (!(messageId in state.unseenSwipes)) return state
        const unseenSwipes = { ...state.unseenSwipes }
        delete unseenSwipes[messageId]
        return { unseenSwipes }
      })
    },

    reconcileStreamContent: (content, offset) => {
      if (get().streamingNavigationPaused) return
      // Apply a pool snapshot (offset 0 = full) or a delta (offset = char
      // position where `content` begins). The pool buffer is append-only
      // within a generation, so a candidate that doesn't extend what's already
      // rendered is a stale snapshot (tokens arrived over WS during the poll's
      // round-trip) — applying it would rewind or hole the visible text.
      if (offset > rawStreamContent.length) return
      const candidate = rawStreamContent.slice(0, offset) + content
      if (candidate.length < rawStreamContent.length) return
      rawStreamContent = candidate
      set({ streamingContent: candidate })
    },

    reconcileStreamReasoning: (reasoning, offset) => {
      if (get().streamingNavigationPaused) return
      if (offset > rawStreamReasoning.length) return
      const candidate = rawStreamReasoning.slice(0, offset) + reasoning
      if (candidate.length < rawStreamReasoning.length) return
      rawStreamReasoning = candidate
      set({ streamingReasoning: candidate })
    },

    getStreamBuffers: () => ({ content: rawStreamContent, reasoning: rawStreamReasoning }),

    setStreamingReasoningStartedAt: (ts) => {
      // Also restore the closure variable so appendStreamToken can finalize
      // the duration when the first content token arrives after recovery.
      reasoningStartedAt = ts ?? 0
      set({ streamingReasoningStartedAt: ts })
    },

    appendStreamToken: (token, offset) => {
      if (get().streamingNavigationPaused) return 'stale'
      // CoT detection (reasoning prefix/suffix separation) is now handled
      // server-side in generate.service.ts. The backend emits pre-separated
      // tokens: regular content tokens here, reasoning tokens via
      // appendStreamReasoning. This avoids duplicating the state machine.
      if (reasoningStartedAt && !get().streamingReasoningDuration) {
        set({ streamingReasoningDuration: Date.now() - reasoningStartedAt })
      }
      if (offset != null) {
        const localLen = rawStreamContent.length
        // Segment starts beyond our buffer — we missed tokens (subscription
        // race after reconnect, events dropped while hidden). Don't append out
        // of place; the caller re-polls the authoritative pool.
        if (offset > localLen) return 'gap'
        if (offset < localLen) {
          // Overlaps content we already hold (recovery snapshot raced the live
          // stream). Slice off exactly the overlap; drop if fully covered.
          const overlap = localLen - offset
          if (token.length <= overlap) return 'stale'
          token = token.slice(overlap)
        }
      }
      rawStreamContent += token
      scheduleStreamFlush()
      return 'appended'
    },

    appendStreamReasoning: (token, offset) => {
      if (get().streamingNavigationPaused) return 'stale'
      if (!reasoningStartedAt) {
        reasoningStartedAt = Date.now()
        // Keep the render-facing timestamp in sync with the private duration
        // clock. Otherwise it can retain a previous chat's recovery timestamp
        // until the next pool poll corrects it.
        set({ streamingReasoningStartedAt: reasoningStartedAt })
      }
      if (offset != null) {
        const localLen = rawStreamReasoning.length
        if (offset > localLen) return 'gap'
        if (offset < localLen) {
          const overlap = localLen - offset
          if (token.length <= overlap) return 'stale'
          token = token.slice(overlap)
        }
      }
      rawStreamReasoning += token
      scheduleStreamFlush()
      return 'appended'
    },

    endStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      // Cap the set size to prevent unbounded growth
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      // Preserve the generation type before clearing — auto-summarization
      // needs to know what kind of generation just finished.
      set({
        isStreaming: false,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        lastGenerationTerminalStatus: 'completed',
        activeGenerationId: null,
        agentActivityByGeneration: {},
        regeneratingMessageId: null,
        streamingSwipeId: null,
        lastCompletedGenerationType: get().streamingGenerationType,
        streamingGenerationType: null,
      })
    },

    stopStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      set((state) => {
        const shouldRemovePlaceholder = isLocalStreamingPlaceholderId(state.regeneratingMessageId)
        return {
          ...(shouldRemovePlaceholder
            ? {
                messages: state.messages.filter((message) => message.id !== state.regeneratingMessageId),
                totalChatLength: Math.max(0, state.totalChatLength - 1),
              }
            : {}),
          isStreaming: false,
          streamingNavigationPaused: false,
          streamingContent: '',
          streamingReasoning: '',
          streamingReasoningDuration: null,
          streamingReasoningStartedAt: null,
          streamingError: null,
          lastGenerationTerminalStatus: 'stopped',
          activeGenerationId: null,
          agentActivityByGeneration: {},
          regeneratingMessageId: null,
          streamingSwipeId: null,
          streamingGenerationType: null,
        }
      })
    },

    setStreamingError: (error) => {
      if (error === null) {
        set({
          streamingError: null,
          lastGenerationTerminalStatus: null,
        })
        return
      }
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      set((state) => {
        const shouldRemovePlaceholder = isLocalStreamingPlaceholderId(state.regeneratingMessageId)
        return {
          ...(shouldRemovePlaceholder
            ? {
                messages: state.messages.filter((message) => message.id !== state.regeneratingMessageId),
                totalChatLength: Math.max(0, state.totalChatLength - 1),
              }
            : {}),
          streamingError: error,
          lastGenerationTerminalStatus: 'error',
          isStreaming: false,
          streamingNavigationPaused: false,
          streamingContent: '',
          streamingReasoning: '',
          streamingReasoningDuration: null,
          streamingReasoningStartedAt: null,
          activeGenerationId: null,
          agentActivityByGeneration: {},
          regeneratingMessageId: null,
          streamingSwipeId: null,
          streamingGenerationType: null,
        }
      })
    },

    markGenerationEnded: (generationId) => {
      endedGenerationIds.add(generationId)
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
    },

    reconcileAgentActivity: (payload) => {
      const normalized = normalizeAgentActivityPayload(payload)
      if (!normalized || endedGenerationIds.has(normalized.generationId)) return
      const activeGenerationId = get().activeGenerationId
      if (activeGenerationId && activeGenerationId !== normalized.generationId) return
      set((state) => ({
        agentActivityByGeneration: reconcileAgentActivityState(state.agentActivityByGeneration, normalized),
      }))
    },
    mergeAgentActivityRuns: (runs) => {
      if (!Array.isArray(runs) || runs.length === 0) return
      set((state) => ({
        agentActivityRunsByGeneration: mergeAgentActivityRuns(state.agentActivityRunsByGeneration, runs),
      }))
    },

    setAgentTerminalError: (generationId, error) => {
      if (!generationId) return
      const normalized = normalizeAgentPublicError(error)
      set((state) => {
        if (!normalized) {
          if (!Object.hasOwn(state.agentTerminalErrorsByGeneration, generationId)) return state
          const next = { ...state.agentTerminalErrorsByGeneration }
          delete next[generationId]
          return { agentTerminalErrorsByGeneration: next }
        }
        return {
          agentTerminalErrorsByGeneration: {
            ...state.agentTerminalErrorsByGeneration,
            [generationId]: normalized,
          },
        }
      })
    },

    clearAgentActivity: (generationId) => {
      set((state) => {
        if (!generationId) {
          return Object.keys(state.agentActivityByGeneration).length > 0
            ? { agentActivityByGeneration: {} }
            : state
        }
        const agentActivityByGeneration = Object.fromEntries(
          Object.entries(state.agentActivityByGeneration)
            .filter(([key, activity]) => activity.generationId !== generationId && !key.startsWith(`${generationId}\u0000`)),
        )
        return { agentActivityByGeneration }
      })
    },

    setImpersonateDraftContent: (content) => set({ impersonateDraftContent: content }),

    // Message selection mode for bulk operations
    messageSelectMode: false,
    selectedMessageIds: [],

    setMessageSelectMode: (enabled) => set({ messageSelectMode: enabled, selectedMessageIds: [] }),

    toggleMessageSelect: (id) => set((state) => {
      const ids = state.selectedMessageIds
      const idx = ids.indexOf(id)
      if (idx >= 0) {
        return { selectedMessageIds: ids.filter((_, i) => i !== idx) }
      }
      return { selectedMessageIds: [...ids, id] }
    }),

    selectAllMessages: () => set((state) => ({
      selectedMessageIds: state.messages.map((m) => m.id),
    })),

    clearMessageSelection: () => set({ selectedMessageIds: [] }),

    selectMessageRange: (fromId, toId) => set((state) => {
      const fromIdx = state.messages.findIndex((m) => m.id === fromId)
      const toIdx = state.messages.findIndex((m) => m.id === toId)
      if (fromIdx < 0 || toIdx < 0) return state
      const start = Math.min(fromIdx, toIdx)
      const end = Math.max(fromIdx, toIdx)
      const rangeIds = state.messages.slice(start, end + 1).map((m) => m.id)
      // Merge with existing selection (union)
      const merged = new Set([...state.selectedMessageIds, ...rangeIds])
      return { selectedMessageIds: [...merged] }
    }),
  }
}
