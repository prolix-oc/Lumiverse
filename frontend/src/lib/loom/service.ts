import type { PromptBlockDTO, PromptVariableDefDTO, PromptVariableOptionDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import type { Preset, CreatePresetInput, UpdatePresetInput, ProviderInfo } from '@/types/api'
import {
  AGENTIC_PREDICATE_MAX_DEPTH,
  AGENTIC_PREDICATE_MAX_LIST_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_ITEMS,
  AGENT_PROFILE_ID_PATTERN,
  AGENT_PROFILE_LIMIT,
  AGENT_PROFILE_NAME_MAX_LENGTH,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENT_MAX_OUTPUT_TOKENS_MIN,
  AGENT_TIMEOUT_MS_MIN,
  CORE_AGENT_TOOL_IDS,
  isAgentTaskTemplate,
  parseAgentRuntimePolicyV1,
} from './agenticRuntime'
import {
  AGENT_INVOCATION_DEFAULT,
  AGENT_INVOCATION_MIN,
  AGENT_TOOL_CALL_DEFAULT,
  AGENT_TOOL_CALL_MIN,
  type AgentConfigV2,
  type AgentRuntimePolicyV1,
  type AgentTaskTemplate,
  type PromptBlock,
  type PromptBlockPlacement,
  type PromptVariableValue,
  type PromptVariableDef,
  type PromptVariableValues,
  type LoomPreset,
  type LoomRegistryEntry,
  type LoomConnectionProfile,
  type MacroGroup,
  type CategoryGroup,
  type PortableSealedPresetDescriptorV1,
  WORKSPACE_CAPABILITIES,
  type WorkspaceCapability,
} from './types'

import { sanitizeCharacterTagTrigger } from './characterTagTrigger'
import { generateUUID } from '@/lib/uuid'
import {
  MARKER_NAMES,
  STRUCTURAL_MARKERS,
  CONTENT_BEARING_MARKERS,
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
  PROVIDER_PARAMS,
  DEFAULT_PROVIDER_PARAMS,
  CATEGORY_MARKER,
  WIKI_CATEGORY_PATTERN,
  WIKI_SUBCATEGORY_PATTERN,
  ST_IDENTIFIER_TO_MARKER,
  MARKER_TO_ST_IDENTIFIER,
} from './constants'

export type PortableAgentConfigV1 = Omit<AgentConfigV2, 'version' | 'cognitionPolicy'> & {
  portableVersion: 1
  /** Optional bounded legacy repair data; never an executable authority. */
  cognitionPolicy?: unknown
}

export interface PortableAgenticRuntimeEnvelopeV1 {
  version: 1
  agentConfig: PortableAgentConfigV1 | null
  taskTemplates: AgentTaskTemplate[]
  /** Backend compatibility alias; parsing moves this into agentConfig.runtimePolicy. */
  runtimePolicy?: AgentRuntimePolicyV1 | null
}

const PORTABLE_ENCODER = new TextEncoder()

const PORTABLE_AGENT_RUNTIME_REQUIRED_KEYS = [
  'version',
  'agentConfig',
  'taskTemplates',
] as const
const PORTABLE_AGENT_RUNTIME_OPTIONAL_KEYS = ['runtimePolicy'] as const

const PORTABLE_AGENT_CONFIG_REQUIRED_KEYS = [
  'portableVersion',
  'agentsEnabled',
  'allowedModes',
  'defaultMode',
  'maxInvocations',
  'maxToolCalls',
  'mainToolIds',
  'mainLoreScope',
  'profiles',
  'connectionSlots',
] as const

const PORTABLE_AGENT_CONFIG_OPTIONAL_KEYS = [
  'cognitionPolicy',
  'taskPolicy',
  'workspacePolicy',
  'runtimePolicy',
] as const

const PORTABLE_AGENT_PROFILE_REQUIRED_KEYS = [
  'id',
  'name',
  'systemPrompt',
  'connectionRef',
  'toolIds',
  'loreScope',
  'allowMainDelegation',
  'failurePolicy',
  'streamActivity',
  'maxOutputTokens',
  'timeoutMs',
] as const
const PORTABLE_AGENT_PROFILE_OPTIONAL_KEYS = [
  'workspaceCapabilities',
] as const

const PORTABLE_AGENT_SLOT_KEYS = [
  'id',
  'label',
  'requiredCapabilities',
] as const


const PORTABLE_AGENT_RUNTIME_POLICY_REQUIRED_KEYS = [
  'version',
  'authority',
  'scope',
  'defaultMode',
  'loomPolicy',
] as const
const PORTABLE_AGENT_RUNTIME_POLICY_OPTIONAL_KEYS = ['phases'] as const
const PORTABLE_AGENT_SLOT_LIMIT = AGENT_PROFILE_LIMIT * 2
const PORTABLE_GRAPH_ARRAY_LIMIT = AGENTIC_PREDICATE_MAX_LIST_ITEMS
const PORTABLE_GRAPH_STRING_LIMIT = AGENTIC_PREDICATE_MAX_LIST_BYTES
const PORTABLE_LEGACY_MAX_DEPTH = AGENTIC_PREDICATE_MAX_DEPTH
const PORTABLE_SCAN_MAX_DEPTH = 64
const PORTABLE_SCAN_MAX_NODES = 16_384
const PORTABLE_SCAN_MAX_BYTES = 16 * 1024 * 1024
const PORTABLE_FORBIDDEN_AUTHORITY_KEY = /^(?:connection(ProfileId|Id)|localConnectionId|connection_id|agentSlotBindings?|slotBindings?|bindingRevision|credential|secret|grant|acl|enabledAuthority)$/i

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function isPortableAgentRuntimePolicy(value: unknown): boolean {
  if (!isPlainDataRecord(value)
    || !hasAllowedKeys(
      value,
      PORTABLE_AGENT_RUNTIME_POLICY_REQUIRED_KEYS,
      PORTABLE_AGENT_RUNTIME_POLICY_OPTIONAL_KEYS,
    )) return false
  try {
    parseAgentRuntimePolicyV1(value)
    return true
  } catch {
    return false
  }
}

function hasSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isDensePortableArray(value: unknown, maxLength = PORTABLE_GRAPH_ARRAY_LIMIT): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return false
    const length = lengthDescriptor.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return false
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false
    }
    return Reflect.ownKeys(value).every((key) => (
      typeof key === 'string'
      && (key === 'length' || /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length)
    ))
  } catch {
    return false
  }
}

function hasNoPortableAuthorityLeak(value: unknown): boolean {
  type ScanFrame =
    | { kind: 'value'; value: unknown; depth: number }
    | { kind: 'array'; value: unknown[]; depth: number; index: number }
    | { kind: 'object'; value: Record<string, unknown>; depth: number; keys: string[]; index: number }

  const stack: ScanFrame[] = [{ kind: 'value', value, depth: 0 }]
  const active = new Set<object>()
  let nodes = 0
  let entries = 0
  let bytes = 0

  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) {
        active.delete(frame.value)
        continue
      }
      const index = frame.index
      frame.index += 1
      stack.push(frame)
      if (++entries > PORTABLE_SCAN_MAX_NODES) return false
      stack.push({ kind: 'value', value: frame.value[index], depth: frame.depth + 1 })
      continue
    }
    if (frame.kind === 'object') {
      if (frame.index >= frame.keys.length) {
        active.delete(frame.value)
        continue
      }
      const key = frame.keys[frame.index]!
      frame.index += 1
      stack.push(frame)
      if (key === 'cognitionPolicy') continue
      if (PORTABLE_FORBIDDEN_AUTHORITY_KEY.test(key)) return false
      bytes += PORTABLE_ENCODER.encode(key).byteLength
      if (bytes > PORTABLE_SCAN_MAX_BYTES || ++entries > PORTABLE_SCAN_MAX_NODES) return false
      stack.push({ kind: 'value', value: frame.value[key], depth: frame.depth + 1 })
      continue
    }

    const current = frame.value
    if (current === null || typeof current !== 'object') {
      if (++nodes > PORTABLE_SCAN_MAX_NODES) return false
      if (typeof current === 'string') {
        bytes += PORTABLE_ENCODER.encode(current).byteLength
        if (bytes > PORTABLE_SCAN_MAX_BYTES) return false
      }
      continue
    }
    if (frame.depth > PORTABLE_SCAN_MAX_DEPTH || active.has(current) || ++nodes > PORTABLE_SCAN_MAX_NODES) return false
    if (Array.isArray(current)) {
      if (!isDensePortableArray(current) || entries > PORTABLE_SCAN_MAX_NODES - current.length) return false
      active.add(current)
      stack.push({ kind: 'array', value: current, depth: frame.depth, index: 0 })
      continue
    }
    if (!isPlainDataRecord(current)) return false
    const keys = Object.keys(current)
    if (entries > PORTABLE_SCAN_MAX_NODES - keys.length) return false
    active.add(current)
    stack.push({ kind: 'object', value: current, depth: frame.depth, keys, index: 0 })
  }
  return true
}


function isBoundedLegacyCognition(value: unknown): boolean {
  type JsonFrame = { value: unknown; depth: number; exit?: object }
  const stack: JsonFrame[] = [{ value, depth: 0 }]
  const active = new Set<object>()
  let bytes = 0
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.exit) {
      active.delete(frame.exit)
      continue
    }
    const current = frame.value
    if (current === null || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
      continue
    }
    if (typeof current === 'string') {
      bytes += PORTABLE_ENCODER.encode(current).byteLength
      if (bytes > PORTABLE_GRAPH_STRING_LIMIT) return false
      continue
    }
    if (typeof current !== 'object'
      || frame.depth > PORTABLE_LEGACY_MAX_DEPTH
      || active.has(current)) return false
    if (Array.isArray(current)) {
      if (!isDensePortableArray(current) || current.length > PORTABLE_GRAPH_ARRAY_LIMIT) return false
      active.add(current)
      stack.push({ value: null, depth: frame.depth, exit: current })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: frame.depth + 1 })
      }
      continue
    }
    if (!isPlainDataRecord(current)) return false
    const entries = Object.entries(current)
    if (entries.length > PORTABLE_GRAPH_ARRAY_LIMIT) return false
    active.add(current)
    stack.push({ value: null, depth: frame.depth, exit: current })
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index]!
      bytes += PORTABLE_ENCODER.encode(key).byteLength
      if (bytes > PORTABLE_GRAPH_STRING_LIMIT) return false
      stack.push({ value: entry, depth: frame.depth + 1 })
    }
  }
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string'
      && PORTABLE_ENCODER.encode(serialized).byteLength <= PORTABLE_GRAPH_STRING_LIMIT
  } catch {
    return false
  }
}

const PORTABLE_AGENT_CAPABILITIES = [
  'generation',
  'streaming',
  'tool_calling',
  'native_tool_continuation',
  'tools_disabled_finalization',
] as const

function isSafePortableId(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || PORTABLE_ENCODER.encode(value).byteLength > maxBytes) return false
  if (value.includes('{{') || value.includes('}}')) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) return false
  }
  return true
}

function isPortableSafeIdList(value: unknown): value is string[] {
  if (!isDensePortableArray(value) || value.length > PORTABLE_GRAPH_ARRAY_LIMIT) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isSafePortableId(entry, 256) || seen.has(entry)) return false
    seen.add(entry)
  }
  return true
}


function isPortableToolList(value: unknown): boolean {
  if (!isDensePortableArray(value)) return false
  const seen = new Set<string>()
  for (const toolId of value) {
    if (typeof toolId !== 'string' || !CORE_AGENT_TOOL_IDS.includes(toolId as typeof CORE_AGENT_TOOL_IDS[number]) || seen.has(toolId)) return false
    seen.add(toolId)
  }
  return true
}

function isPortableCapabilityList(value: unknown): boolean {
  if (!isDensePortableArray(value)) return false
  let previousIndex = -1
  for (const capability of value) {
    const currentIndex = typeof capability === 'string' ? PORTABLE_AGENT_CAPABILITIES.indexOf(capability as typeof PORTABLE_AGENT_CAPABILITIES[number]) : -1
    if (currentIndex < 0 || currentIndex <= previousIndex) return false
    previousIndex = currentIndex
  }
  return true
}

function isWorkspaceCapabilityList(value: unknown): value is WorkspaceCapability[] {
  if (value === undefined) return true
  if (!isDensePortableArray(value)) return false
  let previousIndex = -1
  const seen = new Set<string>()
  for (const capability of value) {
    const currentIndex = typeof capability === 'string'
      ? WORKSPACE_CAPABILITIES.indexOf(capability as WorkspaceCapability)
      : -1
    if (currentIndex < 0 || currentIndex <= previousIndex || seen.has(String(capability))) return false
    seen.add(String(capability))
    previousIndex = currentIndex
  }
  return true
}

function isPortableTaskPolicy(value: unknown): value is { templateIds: string[] } {
  return isPlainDataRecord(value)
    && hasExactKeys(value, ['templateIds'])
    && isPortableSafeIdList(value.templateIds)
}

function isPortableWorkspacePolicy(value: unknown): boolean {
  return isPlainDataRecord(value)
    && hasExactKeys(value, ['retention', 'sharing'])
    && (value.retention === 'turn_terminal' || value.retention === 'chat_lifetime')
    && (value.sharing === 'root_only' || value.sharing === 'view_only')
}

function hasPortableRuntimePolicyConflict(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'runtimePolicy')
    && Object.hasOwn(value, 'cognitionPolicy')
}

function isPortableConnectionRef(value: unknown): boolean {
  return isPlainDataRecord(value)
    && (
      hasExactKeys(value, ['kind']) && value.kind === 'inherit_main'
      || hasExactKeys(value, ['kind', 'slotId']) && value.kind === 'slot'
        && typeof value.slotId === 'string'
        && /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/.test(value.slotId)
    )
}

function isPortableProfile(value: unknown): value is PortableAgentConfigV1['profiles'][number] {
  return isPlainDataRecord(value)
    && hasAllowedKeys(value, PORTABLE_AGENT_PROFILE_REQUIRED_KEYS, PORTABLE_AGENT_PROFILE_OPTIONAL_KEYS)
    && typeof value.id === 'string'
    && AGENT_PROFILE_ID_PATTERN.test(value.id)
    && typeof value.name === 'string'
    && [...value.name].length <= AGENT_PROFILE_NAME_MAX_LENGTH
    && typeof value.systemPrompt === 'string'
    && PORTABLE_ENCODER.encode(value.systemPrompt).byteLength <= AGENT_SYSTEM_PROMPT_MAX_BYTES
    && isPortableConnectionRef(value.connectionRef)
    && isPortableToolList(value.toolIds)
    && isWorkspaceCapabilityList(value.workspaceCapabilities)
    && (value.loreScope === 'active' || value.loreScope === 'all_owned')
    && (value.loreScope !== 'all_owned' || (value.toolIds as unknown[]).some((toolId) => typeof toolId === 'string' && toolId.startsWith('lore_')))
    && typeof value.allowMainDelegation === 'boolean'
    && (value.failurePolicy === 'required' || value.failurePolicy === 'optional')
    && typeof value.streamActivity === 'boolean'
    && Number.isSafeInteger(value.maxOutputTokens)
    && value.maxOutputTokens >= AGENT_MAX_OUTPUT_TOKENS_MIN
    && value.maxOutputTokens <= AGENT_MAX_OUTPUT_TOKENS_MAX
    && Number.isSafeInteger(value.timeoutMs)
    && value.timeoutMs >= AGENT_TIMEOUT_MS_MIN
    && value.timeoutMs % 1_000 === 0
}

function isPortableAgentConfig(value: unknown): value is PortableAgentConfigV1 {
  if (!isPlainDataRecord(value)
    || !hasAllowedKeys(value, PORTABLE_AGENT_CONFIG_REQUIRED_KEYS, PORTABLE_AGENT_CONFIG_OPTIONAL_KEYS)
    || value.portableVersion !== 1
    || typeof value.agentsEnabled !== 'boolean'
    || !isDensePortableArray(value.allowedModes)
    || value.allowedModes.length === 0
    || !value.allowedModes.every((mode) => mode === 'response' || mode === 'agentic')
    || value.allowedModes.includes('response') === false
    || new Set(value.allowedModes).size !== value.allowedModes.length
    || (value.defaultMode !== 'response' && value.defaultMode !== 'agentic')
    || !value.allowedModes.includes(value.defaultMode)
    || !value.agentsEnabled && (value.allowedModes.length !== 1 || value.defaultMode !== 'response')
    || !Number.isSafeInteger(value.maxInvocations) || value.maxInvocations < AGENT_INVOCATION_MIN
    || !Number.isSafeInteger(value.maxToolCalls) || value.maxToolCalls < AGENT_TOOL_CALL_MIN
    || !isPortableToolList(value.mainToolIds)
    || (value.mainLoreScope !== 'active' && value.mainLoreScope !== 'all_owned')
    || value.mainLoreScope === 'all_owned' && !(value.mainToolIds as unknown[]).some((toolId) => typeof toolId === 'string' && toolId.startsWith('lore_'))
    || !isDensePortableArray(value.profiles)
    || value.profiles.length > AGENT_PROFILE_LIMIT
    || !isDensePortableArray(value.connectionSlots)
    || value.connectionSlots.length > PORTABLE_AGENT_SLOT_LIMIT
    || !hasNoPortableAuthorityLeak(value)
    || hasPortableRuntimePolicyConflict(value)
    || Object.hasOwn(value, 'cognitionPolicy') && !isBoundedLegacyCognition(value.cognitionPolicy)
    || Object.hasOwn(value, 'taskPolicy') && !isPortableTaskPolicy(value.taskPolicy)
    || Object.hasOwn(value, 'workspacePolicy') && !isPortableWorkspacePolicy(value.workspacePolicy)
    || Object.hasOwn(value, 'runtimePolicy') && !isPortableAgentRuntimePolicy(value.runtimePolicy)) return false

  const profileIds = new Set<string>()
  const profiles: PortableAgentConfigV1['profiles'] = []
  const slotIds = new Set<string>()
  for (const profile of value.profiles) {
    if (!isPortableProfile(profile) || profileIds.has(profile.id)) return false
    profileIds.add(profile.id)
    profiles.push(profile)
  }
  for (const slot of value.connectionSlots) {
    if (!isPlainDataRecord(slot)
      || !hasExactKeys(slot, PORTABLE_AGENT_SLOT_KEYS)
      || !isSafePortableId(slot.id, 128)
      || !/^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/.test(slot.id)
      || typeof slot.label !== 'string'
      || [...slot.label].length > AGENT_PROFILE_NAME_MAX_LENGTH
      || !isPortableCapabilityList(slot.requiredCapabilities)
      || slotIds.has(slot.id)) return false
    slotIds.add(slot.id)
  }
  return profiles.every((profile) => profile.connectionRef.kind !== 'slot' || slotIds.has(profile.connectionRef.slotId))
}


function isPortableTaskTemplate(value: unknown): value is AgentTaskTemplate {
  return isAgentTaskTemplate(value)
}

function hasPortableGraphStringBudget(value: unknown): boolean {
  type GraphFrame = { value: unknown; depth: number; exit?: object }
  const stack: GraphFrame[] = [{ value, depth: 0 }]
  const active = new Set<object>()
  let bytes = 0
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.exit) {
      active.delete(frame.exit)
      continue
    }
    const current = frame.value
    if (typeof current === 'string') {
      bytes += PORTABLE_ENCODER.encode(current).byteLength
      if (bytes > PORTABLE_GRAPH_STRING_LIMIT) return false
      continue
    }
    if (current === null || typeof current !== 'object') continue
    if (frame.depth > AGENTIC_PREDICATE_MAX_DEPTH || active.has(current)) return false
    active.add(current)
    stack.push({ value: null, depth: frame.depth, exit: current })
    if (Array.isArray(current)) {
      if (!isDensePortableArray(current) || current.length > PORTABLE_GRAPH_ARRAY_LIMIT) return false
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: frame.depth + 1 })
      }
    } else {
      if (!isPlainDataRecord(current) || Object.keys(current).length > PORTABLE_GRAPH_ARRAY_LIMIT) return false
      const entries = Object.entries(current)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entry] = entries[index]!
        bytes += PORTABLE_ENCODER.encode(key).byteLength
        if (bytes > PORTABLE_GRAPH_STRING_LIMIT) return false
        stack.push({ value: entry, depth: frame.depth + 1 })
      }
    }
  }
  return true
}

function hasPortableDependencyClosure(
  items: readonly { id: string; dependencies?: readonly string[] }[],
): boolean {
  const dependencies = new Map(items.map((item) => [item.id, item.dependencies ?? []]))
  for (const item of items) {
    const seen = new Set<string>()
    for (const dependency of item.dependencies ?? []) {
      if (!dependencies.has(dependency) || seen.has(dependency)) return false
      seen.add(dependency)
    }
  }
  const state = new Map<string, 0 | 1 | 2>()
  for (const root of dependencies.keys()) {
    if (state.get(root) === 2) continue
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    state.set(root, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const children = dependencies.get(frame.id) ?? []
      if (frame.next >= children.length) {
        state.set(frame.id, 2)
        stack.pop()
        continue
      }
      const child = children[frame.next]!
      frame.next += 1
      const childState = state.get(child)
      if (childState === 1) return false
      if (childState === 2) continue
      state.set(child, 1)
      stack.push({ id: child, next: 0 })
    }
  }
  return true
}

function isPortableTaskGraph(
  taskTemplatesValue: unknown,
  config: PortableAgentConfigV1 | null,
): boolean {
  if (!isDensePortableArray(taskTemplatesValue)
    || taskTemplatesValue.length > PORTABLE_GRAPH_ARRAY_LIMIT
    || !hasPortableGraphStringBudget(taskTemplatesValue)) return false

  const taskTemplates = taskTemplatesValue.filter((value): value is AgentTaskTemplate => isPortableTaskTemplate(value))
  if (taskTemplates.length !== taskTemplatesValue.length
    || new Set(taskTemplates.map((template) => template.id)).size !== taskTemplates.length
    || !hasPortableDependencyClosure(taskTemplates)) return false

  const configValue = config as unknown as Record<string, unknown> | null
  const taskPolicy = configValue?.taskPolicy
  if (taskTemplates.length > 0 && !taskPolicy) return false
  if (taskPolicy && (!isPortableTaskPolicy(taskPolicy)
    || !taskPolicy.templateIds.every((id) => taskTemplates.some((template) => template.id === id)))) return false
  return true
}

export function isPortableAgenticRuntimeEnvelope(value: unknown): boolean {
  if (!isPlainDataRecord(value)
    || !hasAllowedKeys(value, PORTABLE_AGENT_RUNTIME_REQUIRED_KEYS, PORTABLE_AGENT_RUNTIME_OPTIONAL_KEYS)
    || value.version !== 1
    || !isDensePortableArray(value.taskTemplates)
    || value.taskTemplates.length > PORTABLE_GRAPH_ARRAY_LIMIT
    || !hasNoPortableAuthorityLeak(value)) return false

  const topRuntimePolicy = Object.hasOwn(value, 'runtimePolicy') ? value.runtimePolicy : undefined
  let effectiveAgentConfig: unknown = value.agentConfig
  if (topRuntimePolicy !== undefined && topRuntimePolicy !== null) {
    if (value.agentConfig === null
      || !isPlainDataRecord(value.agentConfig)
      || Object.hasOwn(value.agentConfig, 'runtimePolicy')
      || Object.hasOwn(value.agentConfig, 'cognitionPolicy')) return false
    try {
      effectiveAgentConfig = {
        ...value.agentConfig,
        runtimePolicy: parseAgentRuntimePolicyV1(topRuntimePolicy),
      }
    } catch {
      return false
    }
  }
  if (effectiveAgentConfig !== null && !isPortableAgentConfig(effectiveAgentConfig)) return false
  return isPortableTaskGraph(
    value.taskTemplates,
    effectiveAgentConfig as PortableAgentConfigV1 | null,
  )
}

export function parsePortableAgenticRuntimeEnvelope(value: unknown): PortableAgenticRuntimeEnvelopeV1 {
  if (!isPortableAgenticRuntimeEnvelope(value)) {
    throw new Error('AGENT_RUNTIME_PORTABLE_INVALID')
  }
  const clone = structuredClone(value) as PortableAgenticRuntimeEnvelopeV1
  const topRuntimePolicy = Object.hasOwn(clone, 'runtimePolicy') ? clone.runtimePolicy : undefined
  delete clone.runtimePolicy
  if (clone.agentConfig) {
    const runtimePolicy = topRuntimePolicy !== undefined && topRuntimePolicy !== null
      ? parseAgentRuntimePolicyV1(topRuntimePolicy)
      : Object.hasOwn(clone.agentConfig, 'runtimePolicy')
        ? parseAgentRuntimePolicyV1(clone.agentConfig.runtimePolicy)
        : undefined
    clone.agentConfig = {
      ...clone.agentConfig,
      profiles: clone.agentConfig.profiles.map((profile) => ({
        ...profile,
        workspaceCapabilities: [...(profile.workspaceCapabilities ?? [])],
      })),
      ...(runtimePolicy === undefined
        ? {}
        : {
            runtimePolicy: {
              ...runtimePolicy,
              phases: [...runtimePolicy.phases],
            },
          }),
    }
  }
  return clone
}

function stripPortableAgentRuntimeField(value: object): Record<string, unknown> {
  const clone = { ...(value as Record<string, unknown>) }
  delete clone.agentRuntime
  return clone
}

export function extractPortableAgenticRuntimeEnvelope(value: unknown): PortableAgenticRuntimeEnvelopeV1 | null {
  if (!isPlainDataRecord(value)) return null
  if (Object.hasOwn(value, 'agentRuntime')) {
    return parsePortableAgenticRuntimeEnvelope(value.agentRuntime)
  }
  if (value.type === 'lumiverse_preset' && isPlainDataRecord(value.preset) && Object.hasOwn(value.preset, 'agentRuntime')) {
    return parsePortableAgenticRuntimeEnvelope(value.preset.agentRuntime)
  }
  return null
}
/**
 * Build the inert runtime envelope used when a portable preset has sealed
 * material but no authored runtime configuration. The server's portable
 * import endpoint still owns sealed resolution and digest verification; the
 * null config only makes that import explicit rather than falling back to
 * ordinary preset creation.
 */
export function createEmptyPortableAgenticRuntimeEnvelope(): PortableAgenticRuntimeEnvelopeV1 {
  return {
    version: 1,
    agentConfig: null,
    taskTemplates: [],
  }
}

/** A committed portable import owns its sealed runtime material; never roll it back client-side. */
export function shouldRollbackImportedPreset(
  importedPresetId: string | null,
  portableImportCommitted: boolean,
): importedPresetId is string {
  return importedPresetId !== null && !portableImportCommitted
}

function withoutPortableAgentRuntimeField(value: object): Record<string, unknown> {
  return stripPortableAgentRuntimeField(value)
}

// ============================================================================
// BLOCK FACTORY
// ============================================================================

export function createBlock(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: generateUUID(),
    name: 'New Chat',
    content: '',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    characterTagTrigger: [],
    group: null,
    categoryMode: null,
    ...overrides,
  }
}

export function createMarkerBlock(markerType: string, name?: string): PromptBlock {
  const displayName = name || MARKER_NAMES[markerType] || markerType
  const isStructural = STRUCTURAL_MARKERS.has(markerType)

  return createBlock({
    name: markerType === 'category' ? (name || 'Category') : displayName,
    marker: markerType,
    content: '',
    isLocked: isStructural,
  })
}

function isPromptBlockPlacement(value: unknown): value is PromptBlockPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const placement = value as Partial<PromptBlockPlacement>
  return (
    (placement.role === 'system' || placement.role === 'user' || placement.role === 'assistant' || placement.role === 'user_append' || placement.role === 'assistant_append')
    && (placement.position === 'pre_history' || placement.position === 'post_history' || placement.position === 'in_history')
    && typeof placement.depth === 'number'
    && Number.isFinite(placement.depth)
    && placement.depth >= 0
  )
}

/**
 * Project select-variable placement bindings for UI surfaces that need to
 * display the same role/position/depth the prompt assembler will use. This is
 * read-only and leaves each preset block's persisted fallback unchanged.
 */
export function resolvePromptBlockPlacements(
  blocks: PromptBlock[],
  values: PromptVariableValues,
): PromptBlock[] {
  return blocks.map((block) => {
    const binding = block.placementBinding
    if (
      !binding
      || typeof binding.variableId !== 'string'
      || !binding.variableId
      || !binding.options
      || typeof binding.options !== 'object'
      || Array.isArray(binding.options)
    ) return block

    const selector = block.variables?.find(
      (variable): variable is Extract<PromptVariableDef, { type: 'select' }> => (
        variable.id === binding.variableId && variable.type === 'select'
      ),
    )
    if (!selector) return block

    const validIds = new Set(selector.options.map((option) => option.id))
    const configured = values[block.id]?.[selector.name]
    const fallback = validIds.has(selector.defaultValue)
      ? selector.defaultValue
      : selector.options[0]?.id ?? ''
    const selectedId = typeof configured === 'string' && validIds.has(configured)
      ? configured
      : fallback
    if (!selectedId || !Object.prototype.hasOwnProperty.call(binding.options, selectedId)) return block

    const placement = binding.options[selectedId]
    if (!isPromptBlockPlacement(placement)) return block
    return {
      ...block,
      role: placement.role,
      position: placement.position,
      depth: Math.floor(placement.depth),
    }
  })
}

function projectPublicPromptVariableOption(option: PromptVariableOptionDTO): PromptVariableOptionDTO {
  return {
    id: option.id,
    label: option.label,
    value: option.value,
  }
}

function projectPublicPromptVariable(variable: PromptVariableDef): PromptVariableDefDTO {
  const projected: Record<string, unknown> = {
    id: variable.id,
    name: variable.name,
    label: variable.label,
    type: variable.type,
    defaultValue: Array.isArray(variable.defaultValue)
      ? [...variable.defaultValue]
      : variable.defaultValue,
  }
  if (variable.description !== undefined) projected.description = variable.description
  if (variable.type === 'textarea' && variable.rows !== undefined) projected.rows = variable.rows
  if ((variable.type === 'number' || variable.type === 'slider') && variable.min !== undefined) {
    projected.min = variable.min
  }
  if ((variable.type === 'number' || variable.type === 'slider') && variable.max !== undefined) {
    projected.max = variable.max
  }
  if ((variable.type === 'number' || variable.type === 'slider') && variable.step !== undefined) {
    projected.step = variable.step
  }
  if (variable.type === 'select' || variable.type === 'multiselect') {
    projected.options = variable.options.map(projectPublicPromptVariableOption)
  }
  if (variable.type === 'multiselect' && variable.separator !== undefined) {
    projected.separator = variable.separator
  }
  return projected as PromptVariableDefDTO
}

export function projectPublicPromptBlock(block: PromptBlock): PromptBlockDTO {
  const projected: PromptBlockDTO = {
    id: block.id,
    name: block.name,
    content: block.content,
    role: block.role,
    enabled: block.enabled,
    position: block.position,
    depth: block.depth,
    marker: block.marker,
    isLocked: block.isLocked,
    color: block.color,
    injectionTrigger: [...block.injectionTrigger],
    characterTagTrigger: [...(block.characterTagTrigger ?? [])],
    group: block.group ?? null,
    categoryMode: block.categoryMode ?? null,
  }
  if (block.variables !== undefined) {
    projected.variables = block.variables.map(projectPublicPromptVariable)
  }
  return projected
}

export function projectPublicPromptBlocks(blocks: PromptBlock[]): PromptBlockDTO[] {
  return blocks.map(projectPublicPromptBlock)
}

// ============================================================================
// PRESET MIGRATION
// ============================================================================


/** Preserve backend engine identifiers; only legacy payloads use the classic fallback. */
function preservePresetEngine(engine: unknown): string {
  return typeof engine === 'string' && engine.trim().length > 0 ? engine : 'classic'
}

function migratePreset(preset: LoomPreset): LoomPreset {
  preset.engine = preservePresetEngine(preset.engine)
  if (preset.portableSealedPreset !== undefined && preset.portableSealedPreset !== null) {
    assertPortableSealedDescriptor(preset.portableSealedPreset)
  }
  preset.samplerOverrides = { ...DEFAULT_SAMPLER_OVERRIDES, ...(preset.samplerOverrides || {}) }
  preset.customBody = { ...DEFAULT_CUSTOM_BODY, ...(preset.customBody || {}) }
  preset.promptBehavior = { ...DEFAULT_PROMPT_BEHAVIOR, ...(preset.promptBehavior || {}) }
  preset.completionSettings = { ...DEFAULT_COMPLETION_SETTINGS, ...(preset.completionSettings || {}) }
  preset.advancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, ...(preset.advancedSettings || {}) }
  if (!preset.modelProfiles) preset.modelProfiles = {}
  if (!preset.lastProfileKey) preset.lastProfileKey = null
  preset.coverUrl = typeof preset.coverUrl === 'string' && preset.coverUrl.trim()
    ? preset.coverUrl.trim()
    : null
  preset.presetVersion = typeof preset.presetVersion === 'string' && preset.presetVersion.trim()
    ? preset.presetVersion.trim()
    : null
  preset.portableSourceVersion = typeof preset.portableSourceVersion === 'string' && preset.portableSourceVersion.trim()
    ? preset.portableSourceVersion.trim()
    : null
  preset.lumihubMeta = isRecord(preset.lumihubMeta) ? preset.lumihubMeta : null
  preset.passthroughMetadata = isRecord(preset.passthroughMetadata)
    ? preset.passthroughMetadata
    : {}
  preset.agentConfig ??= null
  if (preset.agentConfig) {
    preset.agentConfig = {
      ...preset.agentConfig,
      profiles: preset.agentConfig.profiles.map((profile) => ({
        ...profile,
        workspaceCapabilities: [...(profile.workspaceCapabilities ?? [])],
      })),
    }
  }
  preset.agentConfigRevision = Number.isSafeInteger(preset.agentConfigRevision)
    ? preset.agentConfigRevision
    : 0
  preset.agentConfigReview ??= null
  preset.agentSlotBindings = isRecord(preset.agentSlotBindings) ? { ...preset.agentSlotBindings } : {}
  preset.agentTaskTemplates = Array.isArray(preset.agentTaskTemplates) ? preset.agentTaskTemplates : []
  if (Array.isArray(preset.blocks)) {
    for (const block of preset.blocks) {
      if (!Array.isArray(block.injectionTrigger)) {
        block.injectionTrigger = []
      }
      block.characterTagTrigger = sanitizeCharacterTagTrigger(block.characterTagTrigger)
      block.categoryMode = block.marker === 'category'
        ? coerceCategoryMode(block.categoryMode)
        : null
      // Blanket-disable snapshots only make sense on category blocks.
      block.savedChildEnabled = block.marker === 'category' && isRecord(block.savedChildEnabled)
        ? Object.fromEntries(Object.entries(block.savedChildEnabled).filter((entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'))
        : undefined
      if (block.sealedSource === 'lumihub') {
        block.sealed = true
      }
      if (block.sealed !== true) {
        delete block.sealed
        delete block.sealedKey
        delete block.sealedSource
        delete block.sealedOriginPresetId
        delete block.sealedOriginVersion
        delete block.sealedSha256
      } else if (typeof block.sealedKey !== 'string') {
        block.sealedKey = block.id
      }
    }
  }
  preset.blocks = normalizeCategoryBlockState(preset.blocks || [])
  return preset
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPlainDataRecord(value: unknown): value is Record<string, any> {
  if (!isRecord(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false
    }
    return true
  } catch {
    return false
  }
}
export const PORTABLE_PRESET_ERROR_CODES = [
  'PORTABLE_PRESET_INVALID',
  'PORTABLE_PROMPT_BLOCK_INVALID',
  'PORTABLE_EXPORT_UNSTABLE',
  'AGENT_RUNTIME_PORTABLE_INVALID',
  'AGENT_RUNTIME_PORTABLE_STALE',
  'AGENT_RUNTIME_PORTABLE_CONTRADICTORY',
  'AGENT_RUNTIME_PORTABLE_REGEX_INVALID',
  'AGENT_RUNTIME_PORTABLE_PRESET_INVALID',
  'AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID',
  'LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE',
  'LUMIHUB_LINK_UNAVAILABLE',
  'LUMIHUB_SEALED_RESOLUTION_FAILED',
  'LUMIHUB_SEALED_DIGEST_MISMATCH',
  'PRESET_REVISION_CONFLICT',
  'PRESET_REVISION_REQUIRED',
] as const

export type PortablePresetErrorCode = typeof PORTABLE_PRESET_ERROR_CODES[number]


export class PortablePresetError extends Error {
  readonly code: PortablePresetErrorCode

  constructor(code: PortablePresetErrorCode, message: string = code) {
    super(message)
    this.name = 'PortablePresetError'
    this.code = code
  }
}

/**
 * Only expose the stable public code from a failed portable operation. The
 * server may include diagnostic text in an ApiError body, but it must never
 * become user-visible UI copy.
 */
export function getPortablePresetErrorCode(error: unknown): PortablePresetErrorCode {
  const candidate = isRecord(error) && isRecord(error.body)
    ? error.body.code
    : isRecord(error)
      ? error.code
      : undefined
  if (typeof candidate === 'string' && PORTABLE_PRESET_ERROR_CODES.includes(candidate as PortablePresetErrorCode)) {
    return candidate as PortablePresetErrorCode
  }
  if (error instanceof PortablePresetError) return error.code
  const message = error instanceof Error ? error.message : ''
  const prefix = message.match(/^[A-Z][A-Z0-9_]+/)
  if (prefix && PORTABLE_PRESET_ERROR_CODES.includes(prefix[0] as PortablePresetErrorCode)) {
    return prefix[0] as PortablePresetErrorCode
  }
  return 'PORTABLE_PRESET_INVALID'
}

const PORTABLE_PROMPT_BLOCK_KEYS: Record<string, true> = {
  id: true,
  name: true,
  content: true,
  role: true,
  enabled: true,
  position: true,
  depth: true,
  marker: true,
  isLocked: true,
  color: true,
  injectionTrigger: true,
  characterTagTrigger: true,
  group: true,
  categoryMode: true,
  savedChildEnabled: true,
  variables: true,
  placementBinding: true,
  stashId: true,
  sealed: true,
  sealedKey: true,
  sealedSource: true,
  sealedOriginPresetId: true,
  sealedOriginVersion: true,
  sealedSha256: true,
  revision: true,
  order: true,
}
const PORTABLE_PROMPT_VARIABLE_OPTION_KEYS: Record<string, true> = {
  id: true,
  label: true,
  value: true,
}
const PORTABLE_PROMPT_PLACEMENT_KEYS: Record<string, true> = {
  role: true,
  position: true,
  depth: true,
}
const PORTABLE_PROMPT_BINDING_KEYS: Record<string, true> = {
  variableId: true,
  options: true,
}
const PORTABLE_PROMPT_ARRAY_LIMIT = AGENTIC_PREDICATE_MAX_LIST_ITEMS
const PORTABLE_PROMPT_FIELDS_MAX_BYTES = AGENTIC_PREDICATE_MAX_LIST_BYTES
const PORTABLE_PROMPT_MAX_NODES = PORTABLE_SCAN_MAX_NODES

type PortablePromptBudget = {
  bytes: number
  nodes: number
}

function portablePromptError(): never {
  throw new PortablePresetError('PORTABLE_PROMPT_BLOCK_INVALID')
}

function chargePortablePromptNodes(budget: PortablePromptBudget, count = 1): void {
  if (!Number.isSafeInteger(count) || count < 0 || budget.nodes > PORTABLE_PROMPT_MAX_NODES - count) {
    portablePromptError()
  }
  budget.nodes += count
}
function assertPortablePromptChildBudget(budget: PortablePromptBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || budget.nodes > PORTABLE_PROMPT_MAX_NODES - count) {
    portablePromptError()
  }
}
function chargePortablePromptBytes(value: string, budget: PortablePromptBudget): void {
  if (value.length > PORTABLE_PROMPT_FIELDS_MAX_BYTES) portablePromptError()
  let bytes: number
  try {
    bytes = PORTABLE_ENCODER.encode(value).byteLength
  } catch {
    portablePromptError()
  }
  budget.bytes += bytes
  if (budget.bytes > PORTABLE_PROMPT_FIELDS_MAX_BYTES) portablePromptError()
}

function assertPortablePromptKnownKeys(
  value: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
  budget: PortablePromptBudget,
): void {
  const keys = Object.keys(value)
  if (keys.some((key) => !Object.hasOwn(allowed, key))) portablePromptError()
  // Native Loom state uses own `undefined` values for optional fields. They
  // are omitted by JSON serialization; required fields still fail their
  // dedicated validators below.
  assertPortablePromptChildBudget(budget, keys.length)
  for (const key of keys) chargePortablePromptBytes(key, budget)
}

function chargePortablePromptText(
  value: unknown,
  budget: PortablePromptBudget,
  nonEmpty = false,
): asserts value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) portablePromptError()
  chargePortablePromptNodes(budget)
  if (value.length > PORTABLE_PROMPT_FIELDS_MAX_BYTES) portablePromptError()
  chargePortablePromptBytes(value, budget)
}

function chargePortablePromptBoolean(value: unknown, budget: PortablePromptBudget): asserts value is boolean {
  if (typeof value !== 'boolean') portablePromptError()
  chargePortablePromptNodes(budget)
}

function chargePortablePromptNumber(value: unknown, budget: PortablePromptBudget): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) portablePromptError()
  chargePortablePromptNodes(budget)
}

function chargePortablePromptNullableText(value: unknown, budget: PortablePromptBudget): void {
  if (value === null) {
    chargePortablePromptNodes(budget)
    return
  }
  chargePortablePromptText(value, budget)
}

function assertPortablePromptStringArray(
  value: unknown,
  budget: PortablePromptBudget,
): asserts value is string[] {
  if (!isDensePortableArray(value, PORTABLE_PROMPT_ARRAY_LIMIT)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptChildBudget(budget, value.length)
  for (let index = 0; index < value.length; index += 1) {
    chargePortablePromptText(value[index], budget)
  }
}

function assertPortablePromptVariableOption(
  value: unknown,
  budget: PortablePromptBudget,
): asserts value is PromptVariableOptionDTO {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_VARIABLE_OPTION_KEYS, budget)
  chargePortablePromptText(value.id, budget, true)
  chargePortablePromptText(value.label, budget)
  chargePortablePromptText(value.value, budget)
}

function assertPortablePromptPlacement(
  value: unknown,
  budget: PortablePromptBudget,
): asserts value is PromptBlockPlacement {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_PLACEMENT_KEYS, budget)
  if (typeof value.role !== 'string'
    || !['system', 'user', 'assistant', 'user_append', 'assistant_append'].includes(value.role)) {
    portablePromptError()
  }
  if (typeof value.position !== 'string'
    || !['pre_history', 'post_history', 'in_history'].includes(value.position)) {
    portablePromptError()
  }
  chargePortablePromptText(value.role, budget)
  chargePortablePromptText(value.position, budget)
  if (typeof value.depth !== 'number' || !Number.isFinite(value.depth) || value.depth < 0) portablePromptError()
  chargePortablePromptNodes(budget)
}

function assertPortablePromptPlacementBinding(
  value: unknown,
  budget: PortablePromptBudget,
): void {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_BINDING_KEYS, budget)
  chargePortablePromptText(value.variableId, budget, true)
  if (!isPlainDataRecord(value.options)) portablePromptError()
  const optionIds = Object.keys(value.options)
  if (optionIds.length > PORTABLE_PROMPT_ARRAY_LIMIT) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptChildBudget(budget, optionIds.length)
  for (const optionId of optionIds) {
    chargePortablePromptBytes(optionId, budget)
    const descriptor = Object.getOwnPropertyDescriptor(value.options, optionId)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) portablePromptError()
    assertPortablePromptPlacement(descriptor.value, budget)
  }
}


function assertPortablePromptVariable(
  value: unknown,
  budget: PortablePromptBudget,
): asserts value is PromptVariableDef {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  const type = value.type
  if (type !== 'text'
    && type !== 'textarea'
    && type !== 'number'
    && type !== 'slider'
    && type !== 'select'
    && type !== 'switch'
    && type !== 'multiselect') portablePromptError()

  const allowed: Record<string, true> = {
    id: true,
    name: true,
    label: true,
    type: true,
    defaultValue: true,
    description: true,
  }
  if (type === 'textarea') allowed.rows = true
  if (type === 'number' || type === 'slider') {
    allowed.min = true
    allowed.max = true
    allowed.step = true
  }
  if (type === 'select' || type === 'multiselect') allowed.options = true
  if (type === 'multiselect') allowed.separator = true
  assertPortablePromptKnownKeys(value, allowed, budget)
  chargePortablePromptText(type, budget)
  chargePortablePromptText(value.id, budget, true)
  chargePortablePromptText(value.name, budget, true)
  chargePortablePromptText(value.label, budget)
  if (value.description !== undefined) chargePortablePromptText(value.description, budget)

  if (type === 'text') {
    chargePortablePromptText(value.defaultValue, budget)
    return
  }
  if (type === 'textarea') {
    chargePortablePromptText(value.defaultValue, budget)
    if (value.rows !== undefined) {
      if (typeof value.rows !== 'number' || !Number.isFinite(value.rows) || !Number.isInteger(value.rows) || value.rows < 1) {
        portablePromptError()
      }
      chargePortablePromptNodes(budget)
    }
    return
  }
  if (type === 'number' || type === 'slider') {
    chargePortablePromptNumber(value.defaultValue, budget)
    const min = value.min
    const max = value.max
    if (type === 'slider' && (typeof min !== 'number' || typeof max !== 'number')) portablePromptError()
    if (min !== undefined) chargePortablePromptNumber(min, budget)
    if (max !== undefined) chargePortablePromptNumber(max, budget)
    if (typeof min === 'number' && typeof max === 'number' && min > max) portablePromptError()
    if (typeof min === 'number' && value.defaultValue < min) portablePromptError()
    if (typeof max === 'number' && value.defaultValue > max) portablePromptError()
    if (value.step !== undefined) {
      chargePortablePromptNumber(value.step, budget)
      if (value.step <= 0) portablePromptError()
    }
    return
  }
  if (type === 'switch') {
    if (value.defaultValue !== 0 && value.defaultValue !== 1) portablePromptError()
    chargePortablePromptNodes(budget)
    return
  }

  if (!isDensePortableArray(value.options, PORTABLE_PROMPT_ARRAY_LIMIT) || value.options.length === 0) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptChildBudget(budget, value.options.length)
  const optionIds = new Set<string>()
  for (let index = 0; index < value.options.length; index += 1) {
    const option = value.options[index]
    assertPortablePromptVariableOption(option, budget)
    if (optionIds.has(option.id)) portablePromptError()
    optionIds.add(option.id)
  }
  if (type === 'select') {
    chargePortablePromptText(value.defaultValue, budget)
    if (!optionIds.has(value.defaultValue)) portablePromptError()
    return
  }
  if (!isDensePortableArray(value.defaultValue, PORTABLE_PROMPT_ARRAY_LIMIT)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptChildBudget(budget, value.defaultValue.length)
  const defaults = new Set<string>()
  for (let index = 0; index < value.defaultValue.length; index += 1) {
    const selectedId = value.defaultValue[index]
    chargePortablePromptText(selectedId, budget)
    if (!optionIds.has(selectedId) || defaults.has(selectedId)) portablePromptError()
    defaults.add(selectedId)
  }
  if (value.separator !== undefined) chargePortablePromptText(value.separator, budget)
}

function assertPortablePromptVariableState(
  value: unknown,
  budget: PortablePromptBudget,
): void {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  const keys = Object.keys(value)
  if (keys.length > PORTABLE_PROMPT_ARRAY_LIMIT) portablePromptError()
  assertPortablePromptChildBudget(budget, keys.length)
  for (const key of keys) {
    chargePortablePromptBytes(key, budget)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'boolean') {
      portablePromptError()
    }
    chargePortablePromptNodes(budget)
  }
}

function assertPortablePromptBlock(
  value: unknown,
  budget: PortablePromptBudget,
): asserts value is PromptBlock {
  if (!isPlainDataRecord(value)) portablePromptError()
  chargePortablePromptNodes(budget)
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_BLOCK_KEYS, budget)
  chargePortablePromptText(value.id, budget)
  if (Object.hasOwn(value, 'name') && value.name !== undefined) chargePortablePromptText(value.name, budget)
  chargePortablePromptText(value.content, budget)
  if (typeof value.role !== 'string'
    || !['system', 'user', 'assistant', 'user_append', 'assistant_append'].includes(value.role)) {
    portablePromptError()
  }
  if (typeof value.position !== 'string'
    || !['pre_history', 'post_history', 'in_history'].includes(value.position)) {
    portablePromptError()
  }
  chargePortablePromptText(value.role, budget)
  chargePortablePromptBoolean(value.enabled, budget)
  chargePortablePromptText(value.position, budget)
  if (!Number.isSafeInteger(value.depth) || value.depth < 0) portablePromptError()
  chargePortablePromptNodes(budget)
  if (value.marker !== null && typeof value.marker !== 'string') portablePromptError()
  if (value.color !== null && typeof value.color !== 'string') portablePromptError()
  if (value.group !== undefined && value.group !== null && typeof value.group !== 'string') portablePromptError()
  chargePortablePromptNullableText(value.marker, budget)
  chargePortablePromptNullableText(value.color, budget)
  if (value.group !== undefined) chargePortablePromptNullableText(value.group, budget)
  chargePortablePromptBoolean(value.isLocked, budget)
  assertPortablePromptStringArray(value.injectionTrigger, budget)
  if (value.characterTagTrigger !== undefined) assertPortablePromptStringArray(value.characterTagTrigger, budget)
  if (value.categoryMode !== undefined
    && value.categoryMode !== null
    && value.categoryMode !== 'radio'
    && value.categoryMode !== 'checkbox') portablePromptError()
  if (value.categoryMode !== undefined) {
    if (value.categoryMode === null) chargePortablePromptNodes(budget)
    else chargePortablePromptText(value.categoryMode, budget)
  }
  if (value.savedChildEnabled !== undefined) assertPortablePromptVariableState(value.savedChildEnabled, budget)
  if (value.variables !== undefined) {
    if (!isDensePortableArray(value.variables, PORTABLE_PROMPT_ARRAY_LIMIT)) portablePromptError()
    chargePortablePromptNodes(budget)
    assertPortablePromptChildBudget(budget, value.variables.length)
    for (let index = 0; index < value.variables.length; index += 1) {
      assertPortablePromptVariable(value.variables[index], budget)
    }
  }
  if (value.placementBinding !== undefined) assertPortablePromptPlacementBinding(value.placementBinding, budget)
  for (const key of ['stashId', 'sealedKey', 'sealedSource', 'sealedOriginPresetId', 'sealedSha256'] as const) {
    if (value[key] !== undefined) chargePortablePromptText(value[key], budget)
  }
  if (value.sealed !== undefined) chargePortablePromptBoolean(value.sealed, budget)
  if (value.sealedOriginVersion !== undefined
    && value.sealedOriginVersion !== null
    && typeof value.sealedOriginVersion !== 'string') portablePromptError()
  if (value.sealedOriginVersion !== undefined) {
    chargePortablePromptNullableText(value.sealedOriginVersion, budget)
  }
  if (value.order !== undefined) {
    if (!Number.isSafeInteger(value.order) || value.order < 0) portablePromptError()
    chargePortablePromptNodes(budget)
  }
  if (value.revision !== undefined) {
    if (typeof value.revision === 'string') chargePortablePromptText(value.revision, budget)
    else {
      if (!Number.isSafeInteger(value.revision) || value.revision < 0) portablePromptError()
      chargePortablePromptNodes(budget)
    }
  }
}

/** Reject malformed prompt blocks before they reach selection or persistence. */
export function assertPortablePromptBlocks(value: unknown): asserts value is PromptBlock[] {
  if (!isDensePortableArray(value, PORTABLE_PROMPT_ARRAY_LIMIT)) portablePromptError()
  const budget: PortablePromptBudget = { bytes: 0, nodes: 0 }
  chargePortablePromptNodes(budget)
  assertPortablePromptChildBudget(budget, value.length)
  for (let index = 0; index < value.length; index += 1) {
    assertPortablePromptBlock(value[index], budget)
  }
}
function validateImportedPromptVariableSchema(preset: LoomPreset): LoomPreset {
  try {
    validatePromptVariableSchema(preset.blocks)
  } catch (error) {
    throw new PortablePresetError(
      'PORTABLE_PROMPT_BLOCK_INVALID',
      error instanceof Error ? error.message : 'PORTABLE_PROMPT_BLOCK_INVALID',
    )
  }
  return preset
}


function isPortableSealedDescriptor(value: unknown): value is PortableSealedPresetDescriptorV1 {
  if (!isPlainDataRecord(value)
    || Object.keys(value).some((key) => key !== 'hubPresetId' && key !== 'hubPresetVersion' && key !== 'blocks')
    || typeof value.hubPresetId !== 'string'
    || !value.hubPresetId.trim()
    || typeof value.hubPresetVersion !== 'string'
    || !value.hubPresetVersion.trim()
    || !isDensePortableArray(value.blocks, PORTABLE_PROMPT_ARRAY_LIMIT)
    || value.blocks.length === 0) {
    return false
  }
  const keys = new Set<string>()
  for (let index = 0; index < value.blocks.length; index += 1) {
    const entry = value.blocks[index]
    if (!isPlainDataRecord(entry)
      || Object.keys(entry).some((key) => key !== 'key' && key !== 'sha256')
      || typeof entry.key !== 'string'
      || !entry.key.trim()
      || keys.has(entry.key.trim())
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      return false
    }
    keys.add(entry.key.trim())
  }
  return true
}

function assertPortableSealedDescriptor(value: unknown): asserts value is PortableSealedPresetDescriptorV1 {
  if (!isPortableSealedDescriptor(value)) {
    throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  }
}

const IMPORTED_AGENT_TOOL_IDS = [
  'lore_list_books',
  'lore_get_book',
  'lore_list_entries',
  'lore_get_entry',
  'lore_search_entries',
  'chat_search_history',
] as const
const IMPORTED_AGENT_TOOL_SET = new Set<string>(IMPORTED_AGENT_TOOL_IDS)
const IMPORTED_AGENT_LORE_TOOL_SET = new Set<string>(IMPORTED_AGENT_TOOL_IDS.slice(0, 5))
const IMPORTED_AGENT_PROFILE_KEYS = [
  'id', 'name', 'systemPrompt', 'connectionProfileId', 'toolIds', 'loreScope',
  'allowMainDelegation', 'failurePolicy', 'streamActivity', 'maxOutputTokens', 'timeoutMs',
]
const IMPORTED_AGENT_CONFIG_KEYS = [
  'version',
  'enabled',
  'maxInvocations',
  'maxToolCalls',
  'mainToolIds',
  'mainLoreScope',
  'profiles',
]

function isImportedAgentToolList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    const seen = new Set<string>()
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, String(index))) return false
      const tool = value[index]
      if (typeof tool !== 'string' || !IMPORTED_AGENT_TOOL_SET.has(tool) || seen.has(tool)) return false
      seen.add(tool)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return false
    }
    return true
  } catch {
    return false
  }
}

function isImportedAgentConfig(value: unknown): value is Record<string, any> {
  if (!isPlainDataRecord(value)) return false
  try {
    const configKeys = Object.keys(value)
    const hasMaxInvocations = Object.hasOwn(value, 'maxInvocations')
    const hasMaxToolCalls = Object.hasOwn(value, 'maxToolCalls')
    const expectedKeyCount = IMPORTED_AGENT_CONFIG_KEYS.length
      - (hasMaxInvocations ? 0 : 1)
      - (hasMaxToolCalls ? 0 : 1)
    if (configKeys.some((key) => !IMPORTED_AGENT_CONFIG_KEYS.includes(key))) return false
    if (configKeys.length !== expectedKeyCount
      || value.version !== 1
      || typeof value.enabled !== 'boolean'
      || (hasMaxInvocations
        && (!Number.isSafeInteger(value.maxInvocations)
          || value.maxInvocations < AGENT_INVOCATION_MIN))
      || (hasMaxToolCalls
        && (!Number.isSafeInteger(value.maxToolCalls)
          || value.maxToolCalls < AGENT_TOOL_CALL_MIN))
      || !isImportedAgentToolList(value.mainToolIds)
      || (value.mainLoreScope !== 'active'
        && value.mainLoreScope !== 'all_owned')
      || !Array.isArray(value.profiles)
      || Object.getPrototypeOf(value.profiles) !== Array.prototype
      || value.profiles.length > 16) return false
    if (value.mainLoreScope === 'all_owned'
      && !value.mainToolIds.some((tool: string) => IMPORTED_AGENT_LORE_TOOL_SET.has(tool))) return false

    const ids = new Set<string>()
    for (let index = 0; index < value.profiles.length; index += 1) {
      if (!Object.hasOwn(value.profiles, String(index))) return false
    }
    return value.profiles.every((profile: unknown) => {
      if (!isPlainDataRecord(profile)
        || Object.keys(profile).length !== IMPORTED_AGENT_PROFILE_KEYS.length
        || Object.keys(profile).some((key) => !IMPORTED_AGENT_PROFILE_KEYS.includes(key))
        || typeof profile.id !== 'string'
        || !/^[a-z][a-z0-9_]{0,63}$/.test(profile.id)
        || ids.has(profile.id)
        || typeof profile.name !== 'string' || profile.name.length > 80
        || typeof profile.systemPrompt !== 'string'
        || PORTABLE_ENCODER.encode(profile.systemPrompt).byteLength > 32 * 1024
        || (profile.connectionProfileId !== null && typeof profile.connectionProfileId !== 'string')
        || profile.connectionProfileId === ''
        || !isImportedAgentToolList(profile.toolIds)
        || (profile.loreScope !== 'active' && profile.loreScope !== 'all_owned')
        || (profile.loreScope === 'all_owned'
          && !profile.toolIds.some((tool: string) => IMPORTED_AGENT_LORE_TOOL_SET.has(tool)))
        || typeof profile.allowMainDelegation !== 'boolean'
        || (profile.failurePolicy !== 'required' && profile.failurePolicy !== 'optional')
        || typeof profile.streamActivity !== 'boolean'
        || !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 64 || profile.maxOutputTokens > 8192
        || !Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 5000 || profile.timeoutMs % 1000 !== 0) return false
      ids.add(profile.id)
      return true
    })
  } catch {
    return false
  }
}

/** Convert explicit imported V1 metadata into an inert normalized V2 draft. */
function migrateImportedLegacyAgentConfigMetadataV1(
  metadata: Record<string, unknown>,
): { metadata: Record<string, unknown>; config: AgentConfigV2 | null } {
  if (!isRecord(metadata) || !Object.hasOwn(metadata, 'agentConfig')) {
    return { metadata: extractPassthroughMetadata(metadata), config: null }
  }
  const descriptor = Object.getOwnPropertyDescriptor(metadata, 'agentConfig')
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('metadata.agentConfig: must be a data property')
  }
  const legacy = descriptor.value
  if (!isImportedAgentConfig(legacy)) {
    throw new Error('metadata.agentConfig: invalid configuration')
  }
  const profiles = legacy.profiles.map((profile: Record<string, any>) => ({
    id: profile.id,
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    connectionRef: profile.connectionProfileId === null
      ? { kind: 'inherit_main' as const }
      : { kind: 'slot' as const, slotId: `profile/${profile.id}` },
    toolIds: [...profile.toolIds],
    workspaceCapabilities: [],
    loreScope: profile.loreScope,
    allowMainDelegation: profile.allowMainDelegation,
    failurePolicy: profile.failurePolicy,
    streamActivity: profile.streamActivity,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: profile.timeoutMs,
  }))
  return {
    metadata: extractPassthroughMetadata(metadata),
    config: {
      version: 2,
      agentsEnabled: false,
      allowedModes: ['response'],
      defaultMode: 'response',
      maxInvocations: Object.hasOwn(legacy, 'maxInvocations')
        ? legacy.maxInvocations
        : AGENT_INVOCATION_DEFAULT,
      maxToolCalls: Object.hasOwn(legacy, 'maxToolCalls')
        ? legacy.maxToolCalls
        : AGENT_TOOL_CALL_DEFAULT,
      mainToolIds: [...legacy.mainToolIds],
      mainLoreScope: legacy.mainLoreScope,
      profiles,
      connectionSlots: profiles.flatMap((profile) => profile.connectionRef.kind === 'slot'
        ? [{
            id: profile.connectionRef.slotId,
            label: profile.name,
            requiredCapabilities: ['generation' as const],
          }]
        : []),
    },
  }
}

function migrateImportedLegacyAgentConfigV1(
  preset: LoomPreset,
  hasCanonicalRuntime = false,
): LoomPreset {
  // Canonical V2 data is authoritative. In particular, never let an
  // obsolete metadata.agentConfig overwrite a top-level config or portable
  // runtime envelope. Still strip the reserved metadata key so it cannot
  // become executable authority on the next round-trip.
  if (hasCanonicalRuntime || preset.agentConfig !== null) {
    return {
      ...preset,
      passthroughMetadata: extractPassthroughMetadata(preset.passthroughMetadata),
    }
  }
  const migrated = migrateImportedLegacyAgentConfigMetadataV1(preset.passthroughMetadata)
  return {
    ...preset,
    passthroughMetadata: migrated.metadata,
    agentConfig: migrated.config,
  }
}

/** Version key is surfaced separately as `presetVersion`; the rest of the bag round-trips verbatim. */
const LUMIHUB_VERSION_META_KEY = '_lumiverse_preset_version'
const LOOM_OWNED_META_KEYS = new Set([
  'source',
  'modelProfiles',
  'schemaVersion',
  'description',
  'coverUrl',
  'cover_url',
  'isDefault',
  'lastProfileKey',
  'promptVariables',
  'portableSealedPreset',
])

const AGENT_RUNTIME_RESERVED_METADATA_KEYS = new Set([
  'agent_config',
  'agent_config_revision',
  'agent_config_review',
  'agent_config_review_required',
  'agentConfig',
  'agentConfigRevision',
  'agentConfigReview',
  'agentConfigReviewRequired',
  'portableAgentConfig',
  'portable_agent_config',
  'agentRuntime',
  'agent_runtime',
])

export function isLoomOwnedPresetMetadataKey(key: string): boolean {
  return LOOM_OWNED_META_KEYS.has(key) || key.startsWith('_lumiverse_')
}

/**
 * Pull the LumiHub provenance bag (install source, hub id, slug, creator) out of a stored
 * preset's metadata so it survives the marshal/unmarshal round-trip. `marshalUpdate` rewrites
 * the metadata column wholesale, so without this these fields would be wiped on the first edit,
 * breaking manifest sync and re-install update tracking. The version key is excluded — it is
 * surfaced as `presetVersion` and re-applied authoritatively on marshal.
 */
function extractLumihubMeta(meta: Record<string, any>): Record<string, unknown> | null {
  const bag: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith('_lumiverse_') && key !== LUMIHUB_VERSION_META_KEY) {
      bag[key] = value
    }
  }
  return Object.keys(bag).length > 0 ? bag : null
}

/**
 * New installs carry an authoritative source marker. Older LumiHub presets
 * predate that marker, so a stored published version remains the compatibility
 * fallback only when no explicit source has been recorded.
 */
export function shouldShowLumiHubPresetBadge(
  preset: Pick<LoomPreset, 'presetVersion' | 'lumihubMeta'>,
): boolean {
  return getRemotePresetOrigin(preset) === 'lumihub'
}

export type RemotePresetOrigin = 'lumihub' | 'illarin'

/** Resolve explicit provenance, retaining the legacy LumiHub-version fallback. */
export function getRemotePresetOrigin(
  preset: Pick<LoomPreset, 'presetVersion' | 'lumihubMeta'>,
): RemotePresetOrigin | null {
  const installSource = preset.lumihubMeta?._lumiverse_install_source
  if (installSource === 'lumihub' || installSource === 'illarin') return installSource
  if (typeof installSource === 'string') return null
  return preset.presetVersion ? 'lumihub' : null
}

function markPresetAsLocalImport(preset: LoomPreset): LoomPreset {
  const migrated = migratePreset(preset)
  migrated.lumihubMeta = {
    ...(migrated.lumihubMeta ?? {}),
    // A file import is a local copy even when its export retains attribution.
    // This prevents it from presenting as, or being updated as, a Hub install.
    _lumiverse_install_source: 'local',
  }
  return migrated
}

function extractPassthroughMetadata(meta: Record<string, any>): Record<string, unknown> {
  const bag: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (isLoomOwnedPresetMetadataKey(key) || AGENT_RUNTIME_RESERVED_METADATA_KEYS.has(key)) continue
    bag[key] = value
  }
  return bag
}

function hasLegacyPromptOrderShape(promptOrder: unknown): boolean {
  if (Array.isArray(promptOrder)) {
    return promptOrder.some((entry) => isRecord(entry) && Array.isArray(entry.order))
  }
  if (isRecord(promptOrder)) {
    return Object.values(promptOrder).some((entry) => isRecord(entry) && Array.isArray(entry.order))
  }
  return false
}

export function looksLikeLegacyPresetData(data: unknown): data is STPresetData {
  return isRecord(data)
    && (Array.isArray(data.prompts) || hasLegacyPromptOrderShape(data.prompt_order))
}

export function looksLikeBackendLoomPresetData(data: unknown): data is Preset {
  return isRecord(data)
    && Array.isArray(data.prompt_order)
    && isRecord(data.parameters)
    && isRecord(data.prompts)
    && isRecord(data.metadata)
}

export function looksLikeLoomPresetData(data: unknown): data is LoomPreset {
  return isRecord(data) && Array.isArray(data.blocks)
}

export function detectImportedPresetKind(data: unknown): 'loom' | 'legacy' | null {
  if (looksLikeWrappedLumiHubPresetData(data) || looksLikeLoomPresetData(data) || looksLikeBackendLoomPresetData(data)) {
    return 'loom'
  }

  if (looksLikeLegacyPresetData(data)) {
    return 'legacy'
  }

  return null
}

export function coerceImportedLoomPreset(data: unknown, fallbackName: string): LoomPreset {
  // Validate the portable envelope before looking at legacy metadata. A
  // canonical envelope (including one with a null config) is still an
  // authority boundary and must prevent metadata.agentConfig fallback.
  const hasCanonicalRuntime = extractPortableAgenticRuntimeEnvelope(data) !== null
  if (looksLikeWrappedLumiHubPresetData(data)) {
    const presetData = withoutPortableAgentRuntimeField(data.preset)
    assertPortablePromptBlocks(presetData.blocks)
    const wrappedCoverUrl = typeof data.cover_url === 'string'
      ? data.cover_url
      : typeof data.coverUrl === 'string'
        ? data.coverUrl
        : typeof data.preset.coverUrl === 'string'
          ? data.preset.coverUrl
          : typeof (data.preset as any).cover_url === 'string'
            ? (data.preset as any).cover_url
            : null
    return validateImportedPromptVariableSchema(migrateImportedLegacyAgentConfigV1(markPresetAsLocalImport({
      ...presetData,
      name: data.preset.name || fallbackName,
      coverUrl: wrappedCoverUrl,
    } as LoomPreset), hasCanonicalRuntime))
  }

  if (looksLikeLoomPresetData(data)) {
    const presetData = withoutPortableAgentRuntimeField(data)
    assertPortablePromptBlocks(presetData.blocks)
    return validateImportedPromptVariableSchema(migrateImportedLegacyAgentConfigV1(markPresetAsLocalImport({
      ...presetData,
      name: data.name || fallbackName,
    } as LoomPreset), hasCanonicalRuntime))
  }

  if (looksLikeBackendLoomPresetData(data)) {
    return validateImportedPromptVariableSchema(migrateImportedLegacyAgentConfigV1(markPresetAsLocalImport({
      ...unmarshalPreset(data),
      passthroughMetadata: { ...data.metadata },
    }), hasCanonicalRuntime))
  }
  if (looksLikeLegacyPresetData(data)) {
    return validateImportedPromptVariableSchema(migrateImportedLegacyAgentConfigV1(markPresetAsLocalImport(
      importFromSTPreset(data, fallbackName),
    ), hasCanonicalRuntime))
  }

  throw new Error('Unrecognized preset JSON format')
}

function looksLikeWrappedLumiHubPresetData(data: unknown): data is { preset: LoomPreset; cover_url?: unknown; coverUrl?: unknown } {
  return isRecord(data)
    && data.type === 'lumiverse_preset'
    && isRecord(data.preset)
    && Array.isArray(data.preset.blocks)
}

function coerceCategoryMode(mode: unknown): PromptBlock['categoryMode'] {
  return mode === 'radio' || mode === 'checkbox' ? mode : null
}

function normalizeCategoryGroups(blocks: PromptBlock[]): PromptBlock[] {
  let currentCategoryId: string | null = null
  return blocks.map((block) => {
    if (block.marker === 'category') {
      currentCategoryId = block.id
      return { ...block, group: null }
    }

    if (block.group !== undefined) {
      return { ...block, group: block.group || null }
    }

    return { ...block, group: currentCategoryId }
  })
}

export function normalizeCategoryBlockState(
  blocks: PromptBlock[],
  preferredBlockIdByCategory?: Map<string, string>,
): PromptBlock[] {
  const normalizedBlocks = normalizeCategoryGroups(blocks.map((block) => ({
    ...block,
    categoryMode: block.marker === 'category'
      ? coerceCategoryMode(block.categoryMode)
      : null,
  })))

  for (const group of computeGroups(normalizedBlocks)) {
    if (!group.categoryBlock || group.categoryBlock.categoryMode !== 'radio') continue

    const enabledChildren = group.children.filter((block) => block.enabled)
    if (enabledChildren.length <= 1) continue

    const preferredId = preferredBlockIdByCategory?.get(group.categoryBlock.id)
    const keepId = preferredId && enabledChildren.some((block) => block.id === preferredId)
      ? preferredId
      : enabledChildren[0].id

    for (let index = 0; index < normalizedBlocks.length; index += 1) {
      const block = normalizedBlocks[index]
      if (
        block.id !== keepId &&
        group.children.some((child) => child.id === block.id) &&
        block.enabled
      ) {
        normalizedBlocks[index] = { ...block, enabled: false }
      }
    }
  }

  return normalizedBlocks
}

export function toggleBlockWithCategoryRules(
  blocks: PromptBlock[],
  blockId: string,
): PromptBlock[] {
  const target = blocks.find((block) => block.id === blockId)
  if (!target) return blocks

  const categoryGroup = computeGroups(blocks).find((group) => (
    group.categoryBlock?.categoryMode === 'radio' &&
    group.children.some((child) => child.id === blockId)
  ))

  if (!categoryGroup?.categoryBlock) {
    return blocks.map((block) => (
      block.id === blockId ? { ...block, enabled: !block.enabled } : block
    ))
  }

  return blocks.map((block) => {
    if (!categoryGroup.children.some((child) => child.id === block.id)) return block
    return { ...block, enabled: block.id === blockId }
  })
}

/**
 * Blanket enable/disable for a category and all of its children — the
 * distinct category-row control beside the marker's own eye toggle.
 *
 * Disabling snapshots every child's enabled state onto the category block
 * (`savedChildEnabled`, persisted with the preset) and turns the marker and
 * all children off. Enabling restores that exact snapshot — a mixed
 * child state comes back mixed — instead of enabling everything
 * indiscriminately. Children missing from the snapshot (added while the
 * category was blanket-disabled) keep their current state. The result runs
 * through category normalization so a radio category still ends with at
 * most one active child even when the snapshot predates that rule.
 */
export function toggleCategoryWithChildren(
  blocks: PromptBlock[],
  categoryId: string,
): PromptBlock[] {
  const category = blocks.find((block) => block.id === categoryId && block.marker === 'category')
  if (!category) return blocks

  const group = computeGroups(blocks).find((candidate) => candidate.categoryBlock?.id === categoryId)
  const childIds = new Set((group?.children ?? []).map((child) => child.id))
  const disabling = category.enabled
  const snapshot = category.savedChildEnabled

  const toggled = blocks.map((block) => {
    if (block.id === categoryId) {
      return {
        ...block,
        enabled: !disabling,
        // Capture on disable; consume on enable.
        savedChildEnabled: disabling
          ? Object.fromEntries((group?.children ?? []).map((child) => [child.id, child.enabled === true]))
          : undefined,
      }
    }
    if (!childIds.has(block.id)) return block
    if (disabling) return { ...block, enabled: false }
    if (!snapshot || !(block.id in snapshot)) return block
    return { ...block, enabled: snapshot[block.id] === true }
  })

  return normalizeCategoryBlockState(toggled)
}

// ============================================================================
// MARSHAL / UNMARSHAL — Convert between Loom shape and backend API shape
// ============================================================================

export function marshalPreset(loom: LoomPreset): CreatePresetInput {
  assertPortablePromptBlocks(loom.blocks)
  const portableSealedPreset = loom.portableSealedPreset ?? null
  if (portableSealedPreset !== null) {
    assertPortableSealedDescriptor(portableSealedPreset)
  }
  const blocks = normalizeCategoryBlockState(loom.blocks)
  assertPortableSealedDescriptorCorrespondence(blocks, portableSealedPreset)
  return {
    name: loom.name,
    provider: 'loom',
    engine: preservePresetEngine(loom.engine),
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      ...extractPassthroughMetadata(loom.passthroughMetadata ?? {}),
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      coverUrl: loom.coverUrl ?? null,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
      promptVariables: pruneOrphanPromptVariables(loom.promptVariables, blocks),
      ...(loom.portableSealedPreset ? { portableSealedPreset: structuredClone(loom.portableSealedPreset) } : {}),
      // Preserve LumiHub provenance + version so an edit doesn't strip them from the metadata column.
      ...(loom.lumihubMeta ?? {}),
      ...(loom.presetVersion ? { _lumiverse_preset_version: loom.presetVersion } : {}),
    },
  }
}
export function unmarshalPreset(preset: Preset): LoomPreset {
  const params = preset.parameters || {}
  const prompts = preset.prompts || {}
  const meta = preset.metadata || {}
  // Hydration accepts backend-owned legacy rows; portable admission validates
  // prompt graphs before they can enter through an import or create boundary.
  const rawBlocks = preset.prompt_order === undefined ? [] : preset.prompt_order
  const portableSealedPreset = meta.portableSealedPreset
  if (portableSealedPreset !== undefined && portableSealedPreset !== null) {
    assertPortableSealedDescriptor(portableSealedPreset)
  }

  const loom: LoomPreset = {
    id: preset.id,
    name: preset.name,
    engine: preservePresetEngine(preset.engine),
    description: meta.description || '',
    coverUrl: typeof meta.coverUrl === 'string' ? meta.coverUrl : (typeof meta.cover_url === 'string' ? meta.cover_url : null),
    presetVersion: typeof meta._lumiverse_preset_version === 'string' ? meta._lumiverse_preset_version : null,
    lumihubMeta: extractLumihubMeta(meta),
    passthroughMetadata: extractPassthroughMetadata(meta),
    ...(portableSealedPreset ? { portableSealedPreset: structuredClone(portableSealedPreset) } : {}),
    schemaVersion: meta.schemaVersion || 1,
    createdAt: preset.created_at,
    updatedAt: preset.updated_at,
    ...(typeof preset.cache_revision === 'number' ? { cacheRevision: preset.cache_revision } : {}),
    agentConfig: preset.agent_config ?? null,
    agentConfigRevision: preset.agent_config_revision ?? 0,
    agentConfigReview: preset.agent_config_review ?? null,
    agentSlotBindings: { ...(preset.agent_slot_bindings ?? {}) },
    agentTaskTemplates: [...(preset.agent_task_templates ?? [])],
    blocks: rawBlocks,
    source: meta.source || null,
    isDefault: meta.isDefault || false,
    samplerOverrides: params.samplerOverrides || { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: params.customBody || { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: prompts.promptBehavior || { ...DEFAULT_PROMPT_BEHAVIOR },
    completionSettings: prompts.completionSettings || { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: prompts.advancedSettings || { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: meta.modelProfiles || {},
    lastProfileKey: meta.lastProfileKey || null,
    promptVariables: meta.promptVariables && typeof meta.promptVariables === 'object'
      ? meta.promptVariables
      : {},
  }

  return migratePreset(loom)
}

export function marshalUpdate(loom: LoomPreset): UpdatePresetInput {
  // Existing presets can contain legacy identities and larger prompt graphs.
  // Their editor path validates every changed public graph before this update.
  const portableSealedPreset = loom.portableSealedPreset ?? null
  if (portableSealedPreset !== null) {
    assertPortableSealedDescriptor(portableSealedPreset)
  }
  const blocks = normalizeCategoryBlockState(loom.blocks)
  assertPortableSealedDescriptorCorrespondence(blocks, portableSealedPreset, true)
  return {
    name: loom.name,
    engine: preservePresetEngine(loom.engine),
    ...(typeof loom.cacheRevision === 'number'
      ? { expected_cache_revision: loom.cacheRevision }
      : {}),
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      ...extractPassthroughMetadata(loom.passthroughMetadata ?? {}),
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      coverUrl: loom.coverUrl ?? null,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
      promptVariables: pruneOrphanPromptVariables(loom.promptVariables, blocks),
      ...(loom.portableSealedPreset ? { portableSealedPreset: structuredClone(loom.portableSealedPreset) } : {}),
      // Preserve LumiHub provenance + version so an edit doesn't strip them from the metadata column.
      ...(loom.lumihubMeta ?? {}),
      ...(loom.presetVersion ? { _lumiverse_preset_version: loom.presetVersion } : {}),
    },
  }
}

/** Remove source-local ownership from regex companions before portable export. */
export function stripPortableRegexOwnership(
  scripts: readonly object[],
): Record<string, unknown>[] {
  return scripts.map((script) => {
    if (!isPlainDataRecord(script)) {
      throw new PortablePresetError('AGENT_RUNTIME_PORTABLE_REGEX_INVALID')
    }
    const portable: Record<string, unknown> = Object.fromEntries(Object.entries(script))
    for (const field of [
      'id',
      'user_id',
      'userId',
      'pack_id',
      'packId',
      'preset_id',
      'presetId',
      'character_id',
      'characterId',
      'owner_extension_identifier',
      'ownerExtensionIdentifier',
      'validation_error_code',
      'validationErrorCode',
      'created_at',
      'createdAt',
      'updated_at',
      'updatedAt',
      'scope_id',
      'scopeId',
    ]) {
      delete portable[field]
    }
    portable.scope = 'global'
    portable.scope_id = null
    return portable
  })
}
export function sanitizeLumiHubSealedBlocksForExport(loom: LoomPreset): LoomPreset {
  assertPortablePromptBlocks(loom.blocks)
  const descriptor = getPortableSealedPresetDescriptor(loom)
  assertPortableSealedDescriptorCorrespondence(loom.blocks, descriptor, true)
  if (!descriptor) return loom
  const digestByKey = new Map(descriptor.blocks.map((entry) => [entry.key.trim(), entry.sha256.toLowerCase()]))
  const manifestKeys = new Set(digestByKey.keys())

  return {
    ...loom,
    blocks: loom.blocks.map((block) => {
      if (!isLumiHubSealedBlock(block)) return block
      const key = getLumiHubSealedExportKey(block, manifestKeys)
      const expectedDigest = key ? digestByKey.get(key) : undefined
      if (!key || !expectedDigest
        || (block.sealedSha256 !== undefined && block.sealedSha256.toLowerCase() !== expectedDigest)) {
        throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
      }
      return {
        ...block,
        content: sealedPresetBlockPlaceholder(key),
        sealed: true,
        sealedKey: key,
        sealedSource: 'lumihub',
      }
    }),
  }
}

export function toPortableAgentConfigV1(config: AgentConfigV2): PortableAgentConfigV1 {
  const { version: _version, ...authored } = structuredClone(config)
  return { portableVersion: 1, ...authored }
}

/**
 * Legacy Loom payloads can carry runtime task rows beside agentConfig, but
 * the agent-config-only import endpoint cannot import those rows. Rejecting
 * the partial graph is safer than silently persisting a config with dangling
 * task references.
 */
export function hasLegacyPortableAgenticRuntimeGraph(loom: LoomPreset): boolean {
  const taskPolicy = loom.agentConfig?.taskPolicy
  return loom.agentTaskTemplates.length > 0
    || (taskPolicy !== undefined && taskPolicy.templateIds.length > 0)
}

export function createPortableLoomExportPayload(
  loom: LoomPreset,
  agentRuntime: PortableAgenticRuntimeEnvelopeV1,
): Record<string, unknown> {
  const exportLoom = sanitizeLumiHubSealedBlocksForExport(loom)
  const descriptor = getPortableSealedPresetDescriptor(exportLoom)
  if (exportLoom.portableSealedPreset !== undefined && exportLoom.portableSealedPreset !== null) {
    assertPortableSealedDescriptor(exportLoom.portableSealedPreset)
  }
  const portableBlocks = exportLoom.blocks.map((block) => {
    if (!isLumiHubSealedBlock(block)) return block
    const portable = { ...block }
    delete portable.sealedOriginPresetId
    delete portable.sealedOriginVersion
    delete portable.sealedSha256
    return portable
  })
  const portablePreset: Record<string, unknown> = {
    ...exportLoom,
    blocks: portableBlocks,
  }
  for (const field of [
    'id',
    'createdAt',
    'updatedAt',
    'cacheRevision',
    'lumihubMeta',
    'isDefault',
    'agentConfig',
    'agentConfigRevision',
    'agentConfigReview',
    'agentSlotBindings',
    'agentTaskTemplates',
  ]) {
    delete portablePreset[field]
  }
  if (descriptor) portablePreset.portableSealedPreset = descriptor
  portablePreset.passthroughMetadata = extractPassthroughMetadata(exportLoom.passthroughMetadata ?? {})
  portablePreset.agentRuntime = structuredClone(parsePortableAgenticRuntimeEnvelope(agentRuntime))
  return portablePreset
}

/** Remove the installation-local identity before a Loom preset leaves this library. */
export function createPortableLoomPresetExport(loom: LoomPreset): Omit<LoomPreset, 'id'> {
  const sanitized = sanitizeLumiHubSealedBlocksForExport(loom)
  const { id: _localPresetId, ...portable } = sanitized
  return portable
}

function getPortableSealedPresetDescriptor(loom: LoomPreset): PortableSealedPresetDescriptorV1 | null {
  if (loom.portableSealedPreset !== undefined && loom.portableSealedPreset !== null) {
    assertPortableSealedDescriptor(loom.portableSealedPreset)
    return structuredClone(loom.portableSealedPreset)
  }
  const sealedBlocks = loom.blocks.filter((block) => isLumiHubSealedBlock(block))
  if (sealedBlocks.length === 0 || sealedBlocks.every(isLocalPublisherSealedBlock)) return null

  const hubPresetId = typeof loom.lumihubMeta?._lumiverse_lumihub_id === 'string'
    ? loom.lumihubMeta._lumiverse_lumihub_id.trim()
    : ''
  const manifest = isRecord(loom.lumihubMeta?._lumiverse_sealed_preset)
    ? loom.lumihubMeta._lumiverse_sealed_preset
    : null
  const hubPresetVersion = typeof manifest?.version === 'string' && manifest.version.trim()
    ? manifest.version.trim()
    : typeof loom.presetVersion === 'string' && loom.presetVersion.trim()
      ? loom.presetVersion.trim()
      : ''
  const blocks = Array.isArray(manifest?.blocks)
    ? manifest.blocks.map((entry) => ({
        key: isRecord(entry) && typeof entry.key === 'string' ? entry.key.trim() : '',
        sha256: isRecord(entry) && typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '',
      }))
    : []
  const descriptor = { hubPresetId, hubPresetVersion, blocks }
  assertPortableSealedDescriptor(descriptor)
  return descriptor
}

function getLumiHubSealedExportKey(block: PromptBlock, manifestKeys: Set<string>): string | null {
  const sealedKey = typeof block.sealedKey === 'string' && block.sealedKey.trim() ? block.sealedKey.trim() : null
  if (sealedKey && (block.sealedSource === 'lumihub' || manifestKeys.has(sealedKey))) return sealedKey

  const placeholderKey = extractExactSealedPlaceholder(block.content || '')
  if (placeholderKey && manifestKeys.has(placeholderKey)) return placeholderKey

  return null
}
function isLumiHubSealedBlock(block: PromptBlock): boolean {
  return block.sealed === true
    || block.sealedSource !== undefined
    || (block.sealed !== undefined && block.sealed !== false)
    || extractExactSealedPlaceholder(block.content || '') !== null
}



function isLocalPublisherSealedBlock(block: PromptBlock): boolean {
  return block.sealed === true
    && block.sealedSource === undefined
    && block.sealedOriginPresetId === undefined
    && block.sealedOriginVersion === undefined
    && block.sealedSha256 === undefined
    && extractExactSealedPlaceholder(block.content || '') === null
}

function assertPortableSealedDescriptorCorrespondence(
  blocks: readonly PromptBlock[],
  descriptor: PortableSealedPresetDescriptorV1 | null,
  allowLocalAuthoring = false,
): void {
  const sealedBlocks = blocks.filter((block) => isLumiHubSealedBlock(block))
  if (sealedBlocks.length === 0) {
    if (descriptor !== null) throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
    return
  }
  if (descriptor === null) {
    if (allowLocalAuthoring && sealedBlocks.every(isLocalPublisherSealedBlock)) return
    throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  }

  const expectedByKey = new Map(
    descriptor.blocks.map((entry) => [entry.key.trim(), entry.sha256.toLowerCase()]),
  )
  const seenKeys = new Set<string>()
  for (const block of sealedBlocks) {
    if ((block.sealed !== undefined && block.sealed !== true)
      || (block.sealedSource !== undefined && block.sealedSource !== 'lumihub')
      || (block.sealedOriginPresetId !== undefined && block.sealedOriginPresetId !== descriptor.hubPresetId)
      || (typeof block.sealedOriginVersion === 'string'
        && block.sealedOriginVersion !== descriptor.hubPresetVersion)) {
      throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
    }
    const sealedKey = typeof block.sealedKey === 'string' && block.sealedKey.trim()
      ? block.sealedKey.trim()
      : null
    const placeholderKey = extractExactSealedPlaceholder(block.content || '')
    const key = sealedKey ?? placeholderKey
    const expectedDigest = key === null ? undefined : expectedByKey.get(key)
    if (!key || !expectedDigest || seenKeys.has(key)
      || (sealedKey !== null && placeholderKey !== null && sealedKey !== placeholderKey)
      || (block.sealedSha256 !== undefined && block.sealedSha256.toLowerCase() !== expectedDigest)) {
      throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
    }
    seenKeys.add(key)
  }
  if (seenKeys.size !== expectedByKey.size
    || [...expectedByKey.keys()].some((key) => !seenKeys.has(key))) {
    throw new PortablePresetError('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  }
}



function sealedPresetBlockPlaceholder(key: string): string {
  return `{{presetBlock::${key}}}`
}

function extractExactSealedPlaceholder(content: string): string | null {
  const match = content.trim().match(/^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/)
  return match?.[1]?.trim() || null
}

function hasEnumerableDataProperty(value: unknown, key: string): { value: unknown } | null {
  if (!value || typeof value !== 'object') return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    return { value: descriptor.value }
  } catch {
    return null
  }
}

function clonePromptVariableValue(value: unknown): PromptVariableValue | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!Array.isArray(value)) return undefined

  const length = readOwnDataProperty(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined
  let ownKeys: (string | symbol)[]
  let enumerableKeys: string[]
  try {
    ownKeys = Reflect.ownKeys(value)
    enumerableKeys = Object.keys(value)
  } catch {
    return undefined
  }
  if (enumerableKeys.length !== length) return undefined
  for (const key of ownKeys) {
    if (
      key !== 'length'
      && (
        typeof key !== 'string'
        || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= length
      )
    ) {
      return undefined
    }
  }
  const entries: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = hasEnumerableDataProperty(value, String(index))
    if (!descriptor || typeof descriptor.value !== 'string') return undefined
    entries.push(descriptor.value)
  }
  return entries
}

function isPromptVariableValueCompatible(
  variable: PromptVariableDef,
  value: PromptVariableValue,
): boolean {
  if (variable.type === 'text' || variable.type === 'textarea') {
    return typeof value === 'string'
  }
  if (variable.type === 'number' || variable.type === 'slider') {
    return typeof value === 'number'
      && Number.isFinite(value)
      && (variable.min === undefined || value >= variable.min)
      && (variable.max === undefined || value <= variable.max)
  }
  if (variable.type === 'switch') {
    return value === 0 || value === 1
  }
  const optionIds = new Set(variable.options.map((option) => option.id))
  if (variable.type === 'select') {
    return typeof value === 'string' && optionIds.has(value)
  }
  return Array.isArray(value)
    && Object.keys(value).length === value.length
    && Reflect.ownKeys(value).every((key) => (
      key === 'length'
      || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
    ))
    && value.every((entry) => typeof entry === 'string' && optionIds.has(entry))
    && new Set(value).size === value.length
}

function cloneCompatiblePromptVariableValue(
  variable: PromptVariableDef,
  value: unknown,
): PromptVariableValue | undefined {
  const cloned = clonePromptVariableValue(value)
  return cloned !== undefined && isPromptVariableValueCompatible(variable, cloned)
    ? cloned
    : undefined
}

export interface PromptVariableSchemaValidationOptions {
  /** Existing native graph used to tolerate only its already-persisted anomalies. */
  legacyBaseline?: PromptBlock[] | null
}

function hasLegacyVariableIdentity(variables: unknown): variables is PromptVariableDef[] {
  if (!Array.isArray(variables)) return false
  const ids = new Set<string>()
  const names = new Set<string>()
  return variables.some((variable) => {
    if (!variable || typeof variable !== 'object') return true
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return true
    if (ids.has(id) || names.has(name)) return true
    ids.add(id)
    names.add(name)
    return false
  })
}

function preservesLegacyVariableIdentity(
  baseline: unknown,
  next: unknown,
): boolean {
  if (!Array.isArray(baseline) || !Array.isArray(next)) return false
  const idCounts = new Map<string, number>()
  const nameCounts = new Map<string, number>()
  for (const variable of next) {
    if (!variable || typeof variable !== 'object') continue
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    if (typeof id === 'string') idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    if (typeof name === 'string') nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  return next.every((variable, index) => {
    if (!variable || typeof variable !== 'object') return false
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    const invalid = typeof id !== 'string'
      || !id.trim()
      || typeof name !== 'string'
      || !name.trim()
      || idCounts.get(id) !== 1
      || nameCounts.get(name) !== 1
    if (!invalid) return true
    const prior = baseline[index]
    return !!prior
      && typeof prior === 'object'
      && (prior as PromptVariableDef).id === id
      && (prior as PromptVariableDef).name === name
  })
}

function samePromptVariableIdentity(previous: PromptBlock, next: PromptBlock): boolean {
  if (previous.variables === undefined || next.variables === undefined) {
    return previous.variables === undefined && next.variables === undefined
  }
  if (!Array.isArray(previous.variables) || !Array.isArray(next.variables)) return false
  return previous.variables.length === next.variables.length
    && previous.variables.every((variable, index) => (
      variable.id === next.variables?.[index]?.id
      && variable.name === next.variables?.[index]?.name
    ))
}

function sameOrRepairablePromptVariableIdentity(previous: PromptBlock, next: PromptBlock): boolean {
  if (samePromptVariableIdentity(previous, next)) return true
  return hasLegacyVariableIdentity(previous.variables)
    && !hasLegacyVariableIdentity(next.variables)
}

function sameNativePromptBlockOccurrence(previous: PromptBlock, next: PromptBlock): boolean {
  return previous.id === next.id && sameOrRepairablePromptVariableIdentity(previous, next)
}

/**
 * Validate the stable identity and name invariants required to migrate prompt
 * values. A native save may pass its current graph as `legacyBaseline`; only
 * duplicate block IDs and invalid variable identities already present there
 * are tolerated, and only when they are unchanged or reduced. Extension draft
 * validation remains strict by default.
 */
export function validatePromptVariableSchema(
  blocks: PromptBlock[],
  options?: PromptVariableSchemaValidationOptions,
): void {
  if (!Array.isArray(blocks)) throw new Error('Invalid Loom prompt-variable schema: blocks must be an array')
  const baseline = options?.legacyBaseline
  const baselineById = new Map<string, PromptBlock[]>()
  for (const block of baseline ?? []) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string') continue
    const entries = baselineById.get(block.id) ?? []
    entries.push(block)
    baselineById.set(block.id, entries)
  }
  const finalById = new Map<string, PromptBlock[]>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string') continue
    const entries = finalById.get(block.id) ?? []
    entries.push(block)
    finalById.set(block.id, entries)
  }
  const legacyBlockIds = new Set<string>()
  const selectedBaselineOccurrences = new Map<string, number[]>()
  for (const [id, baselineOccurrences] of baselineById) {
    const finalOccurrences = finalById.get(id) ?? []
    if (baselineOccurrences.length < 2 || finalOccurrences.length > baselineOccurrences.length) continue
    if (finalOccurrences.length === 0) {
      legacyBlockIds.add(id)
      selectedBaselineOccurrences.set(id, [])
      continue
    }
    const selected = new Array<number>(finalOccurrences.length).fill(-1)
    const availableBaselineOccurrences = new Set(baselineOccurrences.keys())
    for (let finalIndex = 0; finalIndex < finalOccurrences.length; finalIndex += 1) {
      const block = finalOccurrences[finalIndex]!
      const match = baselineOccurrences.findIndex((candidate, baselineIndex) => (
        availableBaselineOccurrences.has(baselineIndex)
        && samePromptVariableIdentity(candidate, block)
      ))
      if (match < 0) continue
      selected[finalIndex] = match
      availableBaselineOccurrences.delete(match)
    }
    for (let finalIndex = 0; finalIndex < finalOccurrences.length; finalIndex += 1) {
      if (selected[finalIndex]! >= 0) continue
      const block = finalOccurrences[finalIndex]!
      const match = baselineOccurrences.findIndex((candidate, baselineIndex) => (
        availableBaselineOccurrences.has(baselineIndex)
        && sameNativePromptBlockOccurrence(candidate, block)
      ))
      if (match < 0) break
      selected[finalIndex] = match
      availableBaselineOccurrences.delete(match)
    }
    if (selected.every((match) => match >= 0)) {
      legacyBlockIds.add(id)
      selectedBaselineOccurrences.set(id, selected)
    }
  }
  const blockIds = new Set<string>()
  const blockOccurrences = new Map<string, number>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id.trim()) {
      throw new Error('Invalid Loom prompt-variable schema: block id must be non-empty')
    }
    if (blockIds.has(block.id) && !legacyBlockIds.has(block.id)) {
      throw new Error(`Invalid Loom prompt-variable schema: duplicate block id "${block.id}"`)
    }
    blockIds.add(block.id)
    const occurrence = blockOccurrences.get(block.id) ?? 0
    blockOccurrences.set(block.id, occurrence + 1)
    if (block.variables === undefined) continue
    if (!Array.isArray(block.variables)) {
      throw new Error(`Invalid Loom prompt-variable schema: variables for "${block.id}" must be an array`)
    }
    const selectedOccurrence = selectedBaselineOccurrences.get(block.id)?.[occurrence]
    const baselineIndex = selectedOccurrence ?? occurrence
    const baselineBlock = baselineById.get(block.id)?.[baselineIndex]
    const allowLegacyIdentity = hasLegacyVariableIdentity(baselineBlock?.variables)
      && preservesLegacyVariableIdentity(baselineBlock?.variables, block.variables)
    const variableIds = new Set<string>()
    const variableNames = new Set<string>()
    for (const variable of block.variables) {
      if (!variable || typeof variable !== 'object') {
        throw new Error(`Invalid Loom prompt-variable schema: invalid variable in block "${block.id}"`)
      }
      if (typeof variable.id !== 'string' || !variable.id.trim()) {
        if (!allowLegacyIdentity) {
          throw new Error(`Invalid Loom prompt-variable schema: variable id in block "${block.id}" must be non-empty`)
        }
      }
      if (typeof variable.name !== 'string' || !variable.name.trim()) {
        if (!allowLegacyIdentity) {
          throw new Error(`Invalid Loom prompt-variable schema: variable name in block "${block.id}" must be non-empty`)
        }
      }
      if (typeof variable.id === 'string' && variableIds.has(variable.id) && !allowLegacyIdentity) {
        throw new Error(`Invalid Loom prompt-variable schema: duplicate variable id "${variable.id}" in block "${block.id}"`)
      }
      if (typeof variable.name === 'string' && variableNames.has(variable.name) && !allowLegacyIdentity) {
        throw new Error(`Invalid Loom prompt-variable schema: duplicate variable name "${variable.name}" in block "${block.id}"`)
      }
      if (typeof variable.id === 'string') variableIds.add(variable.id)
      if (typeof variable.name === 'string') variableNames.add(variable.name)
    }
  }
}

function setPromptVariableValue(
  bucket: Record<string, PromptVariableValue>,
  name: string,
  value: PromptVariableValue,
): void {
  Object.defineProperty(bucket, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function setPromptVariableBucket(
  output: LoomPreset['promptVariables'],
  blockId: string,
  bucket: Record<string, PromptVariableValue>,
): void {
  if (Object.keys(bucket).length === 0) return
  Object.defineProperty(output, blockId, {
    value: bucket,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function readEnumerableArrayItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  const length = readOwnDataProperty(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return []
  const items: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = hasEnumerableDataProperty(value, String(index))
    if (descriptor) items.push(descriptor.value)
  }
  return items
}

function normalizeTolerantPromptVariable(value: unknown): {
  name: string
  variable: PromptVariableDef
} | undefined {
  if (!isRecord(value)) return undefined
  const name = readOwnDataProperty(value, 'name')
  const type = readOwnDataProperty(value, 'type')
  if (typeof name !== 'string' || !name.trim() || typeof type !== 'string') return undefined

  if (type === 'text' || type === 'textarea' || type === 'switch') {
    return { name, variable: { type } as PromptVariableDef }
  }
  if (type === 'number' || type === 'slider') {
    const min = readOwnDataProperty(value, 'min')
    const max = readOwnDataProperty(value, 'max')
    if (
      (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min)))
      || (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max)))
    ) {
      return undefined
    }
    return {
      name,
      variable: {
        type,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      } as PromptVariableDef,
    }
  }
  if (type !== 'select' && type !== 'multiselect') return undefined

  const options = readEnumerableArrayItems(readOwnDataProperty(value, 'options'))
  const optionIds: string[] = []
  for (const option of options) {
    const optionId = readOwnDataProperty(option, 'id')
    if (typeof optionId !== 'string') return undefined
    optionIds.push(optionId)
  }
  return {
    name,
    variable: {
      type,
      options: optionIds.map((id) => ({ id })),
    } as PromptVariableDef,
  }
}

function getTolerantPromptVariableSchemas(
  blocks: unknown,
): Map<string, Map<string, PromptVariableDef[]>> {
  const schemas = new Map<string, Map<string, PromptVariableDef[]>>()
  if (!Array.isArray(blocks)) return schemas
  for (const block of readEnumerableArrayItems(blocks)) {
    const blockId = readOwnDataProperty(block, 'id')
    if (typeof blockId !== 'string' || !blockId.trim()) continue
    const variables = readOwnDataProperty(block, 'variables')
    let byName = schemas.get(blockId)
    if (!byName) {
      byName = new Map<string, PromptVariableDef[]>()
      schemas.set(blockId, byName)
    }
    if (!Array.isArray(variables)) continue
    for (const variable of readEnumerableArrayItems(variables)) {
      const normalized = normalizeTolerantPromptVariable(variable)
      if (!normalized) continue
      const definitions = byName.get(normalized.name)
      if (definitions) {
        definitions.push(normalized.variable)
      } else {
        byName.set(normalized.name, [normalized.variable])
      }
    }
  }
  return schemas
}

function readEnumerableObjectKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

function cloneCompatibleTolerantPromptVariableValue(
  definitions: PromptVariableDef[],
  value: unknown,
): PromptVariableValue | undefined {
  for (const variable of definitions) {
    const compatible = cloneCompatiblePromptVariableValue(variable, value)
    if (compatible !== undefined) return compatible
  }
  return undefined
}

export function pruneOrphanPromptVariables(
  values: LoomPreset['promptVariables'] | undefined,
  blocks: PromptBlock[],
): LoomPreset['promptVariables'] {
  const out = Object.create(null) as LoomPreset['promptVariables']
  const schemas = getTolerantPromptVariableSchemas(blocks)
  if (!isRecord(values)) return out

  for (const [blockId, definitionsByName] of schemas) {
    if (definitionsByName.size === 0) continue
    const bucketDescriptor = hasEnumerableDataProperty(values, blockId)
    if (!bucketDescriptor || !isRecord(bucketDescriptor.value)) continue
    const kept = Object.create(null) as Record<string, PromptVariableValue>
    for (const name of readEnumerableObjectKeys(bucketDescriptor.value)) {
      const valueDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, name)
      const definitions = definitionsByName.get(name)
      if (!valueDescriptor || !definitions) continue
      const compatible = cloneCompatibleTolerantPromptVariableValue(definitions, valueDescriptor.value)
      if (compatible !== undefined) setPromptVariableValue(kept, name, compatible)
    }
    setPromptVariableBucket(out, blockId, kept)
  }
  return out
}

/**
 * Project values against a new block schema. When a prior schema is present,
 * values are migrated by stable block id + variable id before being keyed by
 * the new variable names. A missing prior schema deliberately falls back to
 * current-name pruning for backwards compatibility with older presets.
 */
export function reconcilePromptVariableValues(
  values: LoomPreset['promptVariables'] | undefined,
  previousBlocks: PromptBlock[] | null | undefined,
  nextBlocks: PromptBlock[],
  validationOptions?: PromptVariableSchemaValidationOptions,
): LoomPreset['promptVariables'] {
  validatePromptVariableSchema(nextBlocks, validationOptions)
  if (!Array.isArray(previousBlocks) || previousBlocks.length === 0) {
    return pruneOrphanPromptVariables(values, nextBlocks)
  }
  validatePromptVariableSchema(previousBlocks, validationOptions)

  const output = Object.create(null) as LoomPreset['promptVariables']
  if (!values || typeof values !== 'object' || Array.isArray(values)) return output
  const previousByBlockId = new Map(previousBlocks.map((block) => [block.id, block]))

  for (const block of nextBlocks) {
    const bucketDescriptor = hasEnumerableDataProperty(values, block.id)
    if (!bucketDescriptor || !isRecord(bucketDescriptor.value) || !block.variables?.length) continue
    const previousBlock = previousByBlockId.get(block.id)
    const previousByVariableId = new Map(
      (previousBlock?.variables ?? []).map((variable) => [variable.id, variable]),
    )
    const kept = Object.create(null) as Record<string, PromptVariableValue>

    for (const variable of block.variables) {
      const previousVariable = previousByVariableId.get(variable.id)
      const sourceName = previousVariable?.name ?? variable.name
      const sourceDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, sourceName)
      if (sourceDescriptor) {
        const compatible = cloneCompatiblePromptVariableValue(variable, sourceDescriptor.value)
        if (compatible !== undefined) setPromptVariableValue(kept, variable.name, compatible)
        continue
      }
      // A new variable (or a variable in a new block) has no stable source;
      // preserve a compatible value already keyed by its current name.
      if (previousVariable) continue
      const currentDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, variable.name)
      if (!currentDescriptor) continue
      const compatible = cloneCompatiblePromptVariableValue(variable, currentDescriptor.value)
      if (compatible !== undefined) setPromptVariableValue(kept, variable.name, compatible)
    }
    setPromptVariableBucket(output, block.id, kept)
  }
  return output
}

// ============================================================================
// REGISTRY HELPERS
// ============================================================================

export function buildRegistryEntry(preset: LoomPreset): LoomRegistryEntry {
  return {
    name: preset.name,
    blockCount: preset.blocks?.length || 0,
    coverUrl: preset.coverUrl ?? null,
    updatedAt: preset.updatedAt || Date.now(),
    isDefault: preset.isDefault || false,
  }
}

export function buildRegistryFromPresets(presets: Preset[]): Record<string, LoomRegistryEntry> {
  const registry: Record<string, LoomRegistryEntry> = {}
  for (const p of presets) {
    const loom = unmarshalPreset(p)
    registry[p.id] = buildRegistryEntry(loom)
  }
  return registry
}

// ============================================================================
// CATEGORY GROUP COMPUTATION
// ============================================================================

export function computeGroups(blocks: PromptBlock[] | undefined): CategoryGroup[] {
  if (!blocks?.length) return []
  const result: CategoryGroup[] = []
  let currentGroup: CategoryGroup = { categoryBlock: null, children: [] }

  for (const block of blocks) {
    if (block.marker === 'category') {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
        result.push(currentGroup)
      }
      currentGroup = { categoryBlock: block, children: [] }
    } else {
      if (block.group !== undefined && block.group !== (currentGroup.categoryBlock?.id ?? null)) {
        if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
          result.push(currentGroup)
        }
        currentGroup = { categoryBlock: null, children: [] }
      }
      currentGroup.children.push(block)
    }
  }
  if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
    result.push(currentGroup)
  }
  return result
}

// ============================================================================
// CONNECTION PROFILE DETECTION
// ============================================================================

export function detectSupportedParams(provider: string | null): Set<string> {
  if (!provider) return DEFAULT_PROVIDER_PARAMS
  return PROVIDER_PARAMS[provider] || DEFAULT_PROVIDER_PARAMS
}

const PROVIDER_PARAM_KEY_TO_SAMPLER_KEY: Record<string, string> = {
  max_tokens: 'maxTokens',
  temperature: 'temperature',
  top_p: 'topP',
  min_p: 'minP',
  top_k: 'topK',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  repetition_penalty: 'repetitionPenalty',
}

export function detectSupportedParamsFromProviders(
  provider: string | null,
  providers: ProviderInfo[] | null | undefined,
): Set<string> {
  if (!provider) return DEFAULT_PROVIDER_PARAMS

  const providerInfo = providers?.find((entry) => entry.id === provider)
  const capabilityKeys = providerInfo?.capabilities?.parameters

  if (capabilityKeys && typeof capabilityKeys === 'object') {
    const supported = new Set<string>(['contextSize'])
    for (const apiKey of Object.keys(capabilityKeys)) {
      const samplerKey = PROVIDER_PARAM_KEY_TO_SAMPLER_KEY[apiKey]
      if (samplerKey) supported.add(samplerKey)
    }
    return supported
  }

  return detectSupportedParams(provider)
}

// ============================================================================
// MACRO REGISTRY
// ============================================================================

/** @deprecated Prefer fetching from GET /api/v1/macros. Kept as local fallback. */
export function getAvailableMacros(): MacroGroup[] {
  return [
    {
      category: 'ST Standard',
      macros: [
        { name: 'Scenario', syntax: '{{scenario}}', description: 'Character scenario' },
        { name: 'Personality', syntax: '{{personality}}', description: 'Character personality' },
        { name: 'Description', syntax: '{{description}}', description: 'Character description' },
        { name: 'Character Name', syntax: '{{char}}', description: 'Character name' },
        { name: 'User Name', syntax: '{{user}}', description: 'User name' },
        { name: 'User Persona', syntax: '{{persona}}', description: 'User persona' },
        { name: 'Example Messages', syntax: '{{mesExamples}}', description: 'Example dialogue messages' },
      ],
    },
    {
      category: 'Lumiverse — Lumia Content',
      macros: [
        { name: 'Lumia Definition', syntax: '{{lumiaDef}}', description: 'Selected physical definition' },
        { name: 'Lumia Definition Count', syntax: '{{lumiaDef::len}}', description: 'Number of active definitions' },
        { name: 'Lumia Behavior', syntax: '{{lumiaBehavior}}', description: 'All selected behaviors' },
        { name: 'Lumia Behavior Count', syntax: '{{lumiaBehavior::len}}', description: 'Number of active behaviors' },
        { name: 'Lumia Personality', syntax: '{{lumiaPersonality}}', description: 'All selected personalities' },
        { name: 'Lumia Personality Count', syntax: '{{lumiaPersonality::len}}', description: 'Number of active personalities' },
        { name: 'Lumia Quirks', syntax: '{{lumiaQuirks}}', description: 'User-defined behavioral quirks' },
        { name: 'Random Lumia', syntax: '{{randomLumia}}', description: 'Random Lumia (full)' },
        { name: 'Random Lumia Name', syntax: '{{randomLumia::name}}', description: 'Random Lumia name' },
        { name: 'Random Lumia Physical', syntax: '{{randomLumia::phys}}', description: 'Random Lumia physical definition' },
        { name: 'Random Lumia Personality', syntax: '{{randomLumia::pers}}', description: 'Random Lumia personality' },
        { name: 'Random Lumia Behavior', syntax: '{{randomLumia::behav}}', description: 'Random Lumia behavior' },
      ],
    },
    {
      category: 'Lumiverse — Lumia OOC',
      macros: [
        { name: 'Lumia OOC', syntax: '{{lumiaOOC}}', description: 'OOC commentary prompt' },
        { name: 'Lumia OOC Erotic', syntax: '{{lumiaOOCErotic}}', description: 'Mirror & Synapse erotic OOC' },
        { name: 'Lumia OOC Erotic Bleed', syntax: '{{lumiaOOCEroticBleed}}', description: 'Narrative Rupture erotic bleed' },
        { name: 'OOC Trigger', syntax: '{{lumiaOOCTrigger}}', description: 'OOC trigger countdown/activation' },
      ],
    },
    {
      category: 'Lumiverse — Self-Reference',
      macros: [
        { name: 'Self (my/our)', syntax: '{{lumiaSelf::1}}', description: 'Possessive determiner — my or our' },
        { name: 'Self (mine/ours)', syntax: '{{lumiaSelf::2}}', description: 'Possessive pronoun — mine or ours' },
        { name: 'Self (me/us)', syntax: '{{lumiaSelf::3}}', description: 'Object pronoun — me or us' },
        { name: 'Self (I/we)', syntax: '{{lumiaSelf::4}}', description: 'Subject pronoun — I or we' },
      ],
    },
    {
      category: 'Lumiverse — Loom System',
      macros: [
        { name: 'Loom Style', syntax: '{{loomStyle}}', description: 'Selected narrative style' },
        { name: 'Loom Style Count', syntax: '{{loomStyle::len}}', description: 'Number of active styles' },
        { name: 'Loom Utilities', syntax: '{{loomUtils}}', description: 'All selected utilities' },
        { name: 'Loom Utility Count', syntax: '{{loomUtils::len}}', description: 'Number of active utilities' },
        { name: 'Loom Retrofits', syntax: '{{loomRetrofits}}', description: 'All selected retrofits' },
        { name: 'Loom Retrofit Count', syntax: '{{loomRetrofits::len}}', description: 'Number of active retrofits' },
        { name: 'Loom Summary', syntax: '{{loomSummary}}', description: 'Current story summary' },
        { name: 'Summary Directive', syntax: '{{loomSummaryPrompt}}', description: 'Summarization directive prompt' },
        { name: 'Sovereign Hand', syntax: '{{loomSovHand}}', description: 'Co-pilot mode prompt' },
        { name: 'Sovereign Hand Active', syntax: '{{loomSovHandActive}}', description: 'Sovereign Hand status (yes/no)' },
        { name: 'Last User Message', syntax: '{{loomLastUserMessage}}', description: 'Last user message content' },
        { name: 'Last Char Message', syntax: '{{loomLastCharMessage}}', description: 'Last character message content' },
        { name: 'Last Message Name', syntax: '{{lastMessageName}}', description: 'Name of last message sender' },
        { name: 'Continue Prompt', syntax: '{{loomContinuePrompt}}', description: 'Continuation instructions' },
      ],
    },
    {
      category: 'Lumiverse — Council',
      macros: [
        { name: 'Council Instructions', syntax: '{{lumiaCouncilInst}}', description: 'Council member instructions' },
        { name: 'Council Deliberation', syntax: '{{lumiaCouncilDeliberation}}', description: 'Council tool results' },
        { name: 'State Synthesis', syntax: '{{lumiaStateSynthesis}}', description: 'State synthesis prompt' },
        { name: 'Council Mode Active', syntax: '{{lumiaCouncilModeActive}}', description: 'Council mode status (yes/no)' },
        { name: 'Council Tools Active', syntax: '{{lumiaCouncilToolsActive}}', description: 'Council tools status (yes/no)' },
        { name: 'Council Tools List', syntax: '{{lumiaCouncilToolsList}}', description: 'Available council tools reminder' },
      ],
    },
    {
      category: 'Lumiverse — Utility',
      macros: [
        { name: 'Message Count', syntax: '{{lumiaMessageCount}}', description: 'Current chat message count' },
      ],
    },
  ]
}

// ============================================================================
// ST PRESET IMPORT / EXPORT
// ============================================================================

/** ST prompt object shape (the subset we care about) */
interface STPrompt {
  identifier?: string
  name?: string
  content?: string
  role?: string
  enabled?: boolean
  injection_trigger?: string[]
  lumiverse_character_tag_trigger?: string[]
  system_prompt?: boolean
  marker?: boolean
  injection_position?: number
  injection_depth?: number
  injection_order?: number
  forbid_overrides?: boolean
}

interface STPresetData {
  name?: string
  prompts?: STPrompt[]
  prompt_order?: Record<string, { order?: Array<{ identifier: string; enabled?: boolean }> }>
  extensions?: {
    regex_scripts?: unknown[]
  }
  // Root-level behavior prompts (ST stores these outside the prompts array)
  continue_nudge_prompt?: string
  impersonation_prompt?: string
  group_nudge_prompt?: string
  new_chat_prompt?: string
  new_group_chat_prompt?: string
  send_if_empty?: string
}

/**
 * Convert a single ST prompt entry to an internal block.
 * Recognizes well-known ST identifiers and converts them to marker blocks.
 */
function convertSTPromptToBlock(p: STPrompt, enabled: boolean): PromptBlock {
  const markerType = p.identifier ? ST_IDENTIFIER_TO_MARKER[p.identifier] : undefined
  if (markerType) {
    const block = createMarkerBlock(markerType, p.name || undefined)
    block.enabled = enabled
    block.injectionTrigger = Array.isArray(p.injection_trigger) ? p.injection_trigger.filter((value): value is string => typeof value === 'string') : []
    block.characterTagTrigger = sanitizeCharacterTagTrigger(p.lumiverse_character_tag_trigger)
    if (CONTENT_BEARING_MARKERS.has(markerType) && p.content) {
      block.content = p.content
    }
    return block
  }

  // NemoPresetExt wiki subcategories (<Name>) flatten to category blocks —
  // Lumiverse has only one level of category nesting.
  const rawName = p.name || 'Untitled'
  const wikiCategoryMatch = rawName.match(WIKI_CATEGORY_PATTERN)
  const wikiSubCategoryMatch = !wikiCategoryMatch ? rawName.match(WIKI_SUBCATEGORY_PATTERN) : null
  const isLegacyCategory = rawName.startsWith(CATEGORY_MARKER)
  // Only treat wiki-style tags as categories when the prompt is acting like a
  // heading. Ordinary prompts can legitimately use angle brackets or ===title===
  // names, and those must round-trip as normal blocks.
  const isWikiHeading = (!p.content || !p.content.trim()) && (!!wikiCategoryMatch || !!wikiSubCategoryMatch)
  const isCategory = isLegacyCategory || isWikiHeading

  let displayName = rawName
  if (wikiCategoryMatch) displayName = wikiCategoryMatch[1].trim()
  else if (wikiSubCategoryMatch) displayName = wikiSubCategoryMatch[1].trim()

  let position: PromptBlock['position'] = 'pre_history'
  let depth = 0
  if (p.injection_position === 1 && typeof p.injection_depth === 'number') {
    position = 'in_history'
    depth = p.injection_depth
  }

  return createBlock({
    name: displayName,
    content: p.content || '',
    role: (p.role as PromptBlock['role']) || 'system',
    enabled,
    injectionTrigger: Array.isArray(p.injection_trigger) ? p.injection_trigger.filter((value): value is string => typeof value === 'string') : [],
    characterTagTrigger: sanitizeCharacterTagTrigger(p.lumiverse_character_tag_trigger),
    position,
    depth,
    marker: isCategory ? 'category' : null,
    isLocked: false,
  })
}

/**
 * Import from a legacy preset JSON (the prompts[] array format).
 * Recognizes all well-known identifiers and parses them as marker blocks.
 * Uses prompt_order for enabled status overrides and sequencing.
 */
export function importFromSTPreset(stPresetData: STPresetData, name: string): LoomPreset {
  const now = Date.now()
  const prompts = stPresetData.prompts || []
  const blocks: PromptBlock[] = []

  // Build enabled overrides AND ordering from prompt_order.
  // ST's prompt_order defines the ACTUAL sequence prompts appear in —
  // the prompts[] array is just a definition pool with arbitrary order.
  const enabledOverrides = new Map<string, boolean>()
  const orderSequence: string[] = []
  const promptOrder = stPresetData.prompt_order
  if (promptOrder) {
    const keys = Object.keys(promptOrder)
      .filter(k => promptOrder[k]?.order?.length)
      .sort((a, b) => Number(b) - Number(a))
    // Apply overrides from all orders, highest priority last wins
    for (let i = keys.length - 1; i >= 0; i--) {
      for (const entry of promptOrder[keys[i]].order!) {
        enabledOverrides.set(entry.identifier, entry.enabled !== false)
      }
    }
    // Use the highest-priority key's order as the canonical sequence
    if (keys.length > 0) {
      for (const entry of promptOrder[keys[0]].order!) {
        orderSequence.push(entry.identifier)
      }
    }
  }

  // Build a lookup map from identifier → prompt object
  const promptByIdentifier = new Map<string, STPrompt>()
  for (const p of prompts) {
    if (p.identifier) promptByIdentifier.set(p.identifier, p)
  }

  const processedIdentifiers = new Set<string>()

  // First pass: follow prompt_order sequence
  for (const identifier of orderSequence) {
    const p = promptByIdentifier.get(identifier)
    if (!p) continue
    processedIdentifiers.add(identifier)

    const enabled = p.identifier && enabledOverrides.has(p.identifier)
      ? enabledOverrides.get(p.identifier)!
      : (p.enabled !== false)

    blocks.push(convertSTPromptToBlock(p, enabled))
  }

  // Second pass: append any prompts not in prompt_order (preserves prompts[] order)
  for (const p of prompts) {
    if (p.identifier && processedIdentifiers.has(p.identifier)) continue
    processedIdentifiers.add(p.identifier || '')

    const enabled = p.identifier && enabledOverrides.has(p.identifier)
      ? enabledOverrides.get(p.identifier)!
      : (p.enabled !== false)

    blocks.push(convertSTPromptToBlock(p, enabled))
  }

  // Ensure chat_history marker exists
  const hasChatHistory = blocks.some(b => b.marker === 'chat_history')
  if (!hasChatHistory) {
    let insertIdx = blocks.length
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].position === 'in_history' || blocks[i].position === 'post_history') {
        insertIdx = i
        break
      }
    }
    blocks.splice(insertIdx, 0, createMarkerBlock('chat_history'))
  }

  return {
    id: generateUUID(),
    name,
    engine: 'classic',
    description: `Imported from legacy preset "${stPresetData.name || name}"`,
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    agentConfig: null,
    agentConfigRevision: 0,
    agentConfigReview: null,
    agentSlotBindings: {},
    agentTaskTemplates: [],
    // `createBlock` gives every block a `group: null` default. That is the
    // right default for a manually-created block, but a null group is explicit
    // to the category renderer, so it prevents the imported blocks from being
    // associated with the preceding ST category heading. Preserve ST's
    // sequential category layout by assigning each prompt to that heading.
    blocks: assignSTCategoryGroups(blocks),
    source: {
      type: 'st_import',
      slug: null,
      importedVersion: null,
      importedName: stPresetData.name || name,
      importedAt: now,
    },
    isDefault: false,
    samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: {
      ...DEFAULT_PROMPT_BEHAVIOR,
      ...(stPresetData.continue_nudge_prompt != null && { continueNudge: stPresetData.continue_nudge_prompt }),
      ...(stPresetData.impersonation_prompt != null && { impersonationPrompt: stPresetData.impersonation_prompt }),
      ...(stPresetData.group_nudge_prompt != null && { groupNudge: stPresetData.group_nudge_prompt }),
      ...(stPresetData.new_chat_prompt != null && { newChatPrompt: stPresetData.new_chat_prompt }),
      ...(stPresetData.new_group_chat_prompt != null && { newGroupChatPrompt: stPresetData.new_group_chat_prompt }),
      ...(stPresetData.send_if_empty != null && { sendIfEmpty: stPresetData.send_if_empty }),
    },
    completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: {},
    lastProfileKey: null,
    promptVariables: {},
  }
}

/**
 * SillyTavern represents categories solely as ordered heading prompts. Its
 * child prompts do not carry a category id, so derive one from their position.
 */
function assignSTCategoryGroups(blocks: PromptBlock[]): PromptBlock[] {
  let currentCategoryId: string | null = null

  return blocks.map((block) => {
    if (block.marker === 'category') {
      currentCategoryId = block.id
      return { ...block, group: null }
    }
    return { ...block, group: currentCategoryId }
  })
}


/**
 * Export a Loom preset to SillyTavern-compatible JSON format.
 * Reverse of importFromSTPreset — maps blocks back to ST prompts/prompt_order
 * and flattens behavior/sampler settings to ST root-level fields.
 */
export function exportToSTPreset(loom: LoomPreset): Record<string, any> {
  const exportLoom = sanitizeLumiHubSealedBlocksForExport(loom)
  const prompts: Array<Record<string, any>> = []
  const orderEntries: Array<{ identifier: string; enabled: boolean }> = []

  for (const block of exportLoom.blocks) {
    // Determine ST identifier — well-known markers use their ST name,
    // everything else (custom blocks, categories) uses the block's own UUID
    const markerMapping = block.marker && block.marker !== 'category'
      ? MARKER_TO_ST_IDENTIFIER[block.marker]
      : undefined
    const identifier = markerMapping ?? block.id
    const isWellKnown = !!markerMapping

    // Map position → injection_position / injection_depth
    let injection_position = 0
    let injection_depth = 4
    if (block.position === 'in_history') {
      injection_position = 1
      injection_depth = block.depth
    } else if (block.position === 'post_history') {
      injection_position = 1
      injection_depth = 0
    }

    // Map role (user_append/assistant_append → base role for ST)
    const role = block.role === 'user_append' ? 'user'
      : block.role === 'assistant_append' ? 'assistant'
      : block.role

    // Build ST prompt entry
    const stPrompt: Record<string, any> = {
      identifier,
      name: block.marker === 'category' && !block.name.startsWith(CATEGORY_MARKER)
        ? `${CATEGORY_MARKER}${block.name}`
        : block.name,
      content: block.content || '',
      role,
      enabled: block.enabled,
      system_prompt: false,
      marker: isWellKnown,
      injection_position,
      injection_depth,
      injection_order: 100,
      forbid_overrides: false,
    }

    // Include injection_trigger for non-marker prompts (maps 1:1 with ST)
    if (!isWellKnown) {
      stPrompt.injection_trigger = block.injectionTrigger ?? []
    }
    if (block.characterTagTrigger?.length) {
      stPrompt.lumiverse_character_tag_trigger = block.characterTagTrigger
    }

    prompts.push(stPrompt)
    orderEntries.push({ identifier, enabled: block.enabled })
  }

  // Build root-level sampler values
  const samplers = exportLoom.samplerOverrides ?? DEFAULT_SAMPLER_OVERRIDES
  const behavior = exportLoom.promptBehavior ?? DEFAULT_PROMPT_BEHAVIOR
  const completion = exportLoom.completionSettings ?? DEFAULT_COMPLETION_SETTINGS
  const advanced = exportLoom.advancedSettings ?? DEFAULT_ADVANCED_SETTINGS

  return {
    // Sampler params at root level (ST convention: these come first)
    temperature: samplers.temperature ?? 1,
    frequency_penalty: samplers.frequencyPenalty ?? 0,
    presence_penalty: samplers.presencePenalty ?? 0,
    top_p: samplers.topP ?? 1,
    top_k: samplers.topK ?? 0,
    top_a: 0,
    min_p: samplers.minP ?? 0,
    repetition_penalty: samplers.repetitionPenalty ?? 1,
    max_context_unlocked: false,
    openai_max_context: samplers.contextSize ?? 128000,
    openai_max_tokens: samplers.maxTokens ?? 4096,

    // Behavior prompts
    names_behavior: completion.namesBehavior ?? 0,
    send_if_empty: behavior.sendIfEmpty ?? '',
    impersonation_prompt: behavior.impersonationPrompt ?? '',
    new_chat_prompt: behavior.newChatPrompt ?? '',
    new_group_chat_prompt: behavior.newGroupChatPrompt ?? '',
    new_example_chat_prompt: '',
    continue_nudge_prompt: behavior.continueNudge ?? '',
    group_nudge_prompt: behavior.groupNudge ?? '',

    // ST formatting defaults
    bias_preset_selected: 'Default (none)',
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',

    stream_openai: true,

    // Prompt blocks + ordering
    name: exportLoom.name,
    prompts,
    prompt_order: [{ character_id: 100001, order: orderEntries }],

    // Completion settings
    assistant_prefill: completion.assistantPrefill ?? '',
    assistant_impersonation: completion.assistantImpersonation ?? '',
    use_sysprompt: completion.useSystemPrompt ?? true,
    squash_system_messages: completion.squashSystemMessages ?? false,
    continue_prefill: completion.continuePrefill ?? false,
    continue_postfix: completion.continuePostfix ?? ' ',
    function_calling: completion.enableFunctionCalling ?? false,
    enable_web_search: completion.enableWebSearch ?? false,
    media_inlining: completion.sendInlineMedia ?? false,

    // Advanced
    seed: advanced.seed ?? -1,
    n: 1,
    ...(advanced.customStopStrings?.length && {
      custom_stopping_strings: JSON.stringify(advanced.customStopStrings),
    }),
  }
}

// ============================================================================
// NEW PRESET FACTORY
// ============================================================================

export function createNewLoomPreset(name: string, description = ''): LoomPreset {
  const now = Date.now()
  return {
    id: generateUUID(),
    name,
    engine: 'classic',
    description,
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    agentConfig: null,
    agentConfigRevision: 0,
    agentConfigReview: null,
    agentSlotBindings: {},
    agentTaskTemplates: [],
    blocks: [
      createBlock({ name: 'System Prompt', content: '', role: 'system', position: 'pre_history' }),
      createMarkerBlock('chat_history'),
    ],
    source: null,
    isDefault: false,
    samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: { ...DEFAULT_PROMPT_BEHAVIOR },
    completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: {},
    lastProfileKey: null,
    promptVariables: {},
  }
}
