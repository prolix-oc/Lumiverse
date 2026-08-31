import { describe, expect, test } from 'bun:test'
import type {
  AgenticRuntimeSaveDraft,
  LoomPassthroughMetadata,
  LoomPreset,
  PromptBlock,
} from './types'
import type { LoomPolicyEntryV1 } from '@/types/agent-runtime'
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} from './constants'
import {
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENTIC_PREDICATE_MAX_DEPTH,
  AGENTIC_PREDICATE_MAX_NODES,
  AGENTIC_PREDICATE_MAX_STRING_BYTES,
  AGENTIC_TASK_TEMPLATE_LIMIT,
  AGENT_PROFILE_NAME_MAX_LENGTH,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_TIMEOUT_MS_MIN,
  createAgenticRuntimeDraft,
  createDefaultAgentConfigV2,
  createAgentProfileV2,
  createLoomPolicyEntryV1,
  getAgenticRuntimeRepairItems,
  getAgentRuntimePolicyBuckets,
  inspectLoomPromptPoliciesV1,
  normalizeAgentConfigForEditor,
  parseAgentCustomPhasesV1,
  parseAgentRuntimePolicyV1,
  parseLoomPolicyBucketsV1,
  prepareAgentConfigForRuntimeSave,
  requiredReviewAcknowledgements,
  setAgentRuntimeCustomPhases,
  setAgentRuntimePolicyBuckets,
  validateAgenticRuntimeDraft,
} from './agenticRuntime'

const block = (revision = 3): PromptBlock => ({
  id: 'policy-block',
  name: 'Work policy',
  content: 'Use the workspace before completing.',
  role: 'system',
  enabled: true,
  position: 'pre_history',
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  revision,
})

const draft = (): AgenticRuntimeSaveDraft => ({
  config: createDefaultAgentConfigV2(),
  slotBindings: {},
  taskTemplates: [],
  reviewAcknowledgements: [],
})

const presetWithMetadata = (metadata: LoomPassthroughMetadata): LoomPreset => ({
  id: 'preset-1',
  name: 'Preset',
  engine: 'classic',
  description: '',
  coverUrl: null,
  presetVersion: null,
  lumihubMeta: null,
  passthroughMetadata: metadata,
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  cacheRevision: 8,
  agentConfig: null,
  agentConfigRevision: 0,
  agentConfigReview: null,
  agentSlotBindings: {},
  agentTaskTemplates: [],
  blocks: [block()],
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
})

describe('Agentic Runtime shared draft validation', () => {
  test('does not execute legacy metadata as runtime authority', () => {
    const preset = presetWithMetadata({
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 6,
        maxToolCalls: 7,
        mainToolIds: ['chat_search_history'],
        mainLoreScope: 'active',
        profiles: [{
          id: 'researcher',
          name: 'Researcher',
          systemPrompt: 'Research.',
          connectionProfileId: 'local-connection',
          toolIds: ['lore_get_entry'],
          loreScope: 'active',
          allowMainDelegation: true,
          failurePolicy: 'required',
          streamActivity: true,
          maxOutputTokens: 256,
          timeoutMs: 30_000,
        }],
      },
    })

    const migrated = createAgenticRuntimeDraft(preset)
    expect(migrated.config.version).toBe(2)
    expect(migrated.config.agentsEnabled).toBe(false)
    expect(migrated.config.allowedModes).toEqual(['response'])
    expect(migrated.config.profiles).toEqual([])
    expect(migrated.config.connectionSlots).toEqual([])
  })

  test('rejects stale block references instead of silently changing phased instructions', () => {
    const candidate = draft()
    const staleEntry = createLoomPolicyEntryV1('workPolicy', block(3), 8, 0)
    candidate.config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [{
        ...staleEntry,
        source: { ...staleEntry.source, blockRevision: 2 },
      }],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }

    const result = validateAgenticRuntimeDraft(candidate, [block(3)], 8)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual({
      code: 'stale_policy_source',
      path: 'config.runtimePolicy.loomPolicy.workPolicy.0.source',
    })
  })
  test('submits exact sources at the loaded preset revision for server-owned conditional rebase', () => {
    const config = createDefaultAgentConfigV2()
    config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [createLoomPolicyEntryV1('workPolicy', block(3), 8, 0)],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }

    const prepared = prepareAgentConfigForRuntimeSave(config, [block(3)], 8)

    expect(prepared.runtimePolicy?.loomPolicy.workPolicy[0]?.source.presetRevision).toBe(8)
  })

  test('keeps duplicate block IDs distinct by prompt occurrence during save and repair validation', () => {
    const first = { ...block(3), name: 'First occurrence', content: 'First occurrence content.' }
    const second = { ...block(7), name: 'Second occurrence', content: 'Second occurrence content.' }
    const config = createDefaultAgentConfigV2()
    config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [
        createLoomPolicyEntryV1('workPolicy', first, 8, 0),
        createLoomPolicyEntryV1('workPolicy', second, 8, 1),
      ],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }

    const prepared = prepareAgentConfigForRuntimeSave(config, [first, second], 8)
    const entries = prepared.runtimePolicy?.loomPolicy.workPolicy ?? []
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2)
    expect(entries.map((entry) => entry.source.promptOrder)).toEqual([0, 1])
    expect(entries[0]?.source).toMatchObject({ blockId: 'policy-block', promptOrder: 0, presetRevision: 8, blockRevision: 3 })
    expect(entries[1]?.source).toMatchObject({ blockId: 'policy-block', promptOrder: 1, presetRevision: 8, blockRevision: 7 })
    expect(validateAgenticRuntimeDraft({ ...draft(), config: prepared }, [first, second], 8).valid).toBe(true)

    const moved = createLoomPolicyEntryV1('workPolicy', second, 8, 0)
    config.runtimePolicy!.loomPolicy = {
      ...config.runtimePolicy!.loomPolicy,
      workPolicy: [moved],
    }
    expect(() => prepareAgentConfigForRuntimeSave(config, [first, second], 8)).toThrow()

    const categorySecond = { ...second, marker: 'category' as const }
    config.runtimePolicy!.loomPolicy = {
      ...config.runtimePolicy!.loomPolicy,
      workPolicy: [createLoomPolicyEntryV1('workPolicy', categorySecond, 8, 1)],
    }
    expect(() => prepareAgentConfigForRuntimeSave(config, [first, categorySecond], 8)).toThrow()
  })

  test('rejects cyclic task dependencies', () => {
    const candidate = draft()
    candidate.taskTemplates = [
      { id: 'first', required: true, dependencies: ['second'], activation: { kind: 'phase', value: 'WORK' } },
      { id: 'second', required: true, dependencies: ['first'], activation: { kind: 'phase', value: 'WORK' } },
    ]
    const result = validateAgenticRuntimeDraft(candidate, [], 0)
    expect(result.issues.some((issue) => issue.code === 'cyclic_task_dependency')).toBe(true)
  })
 
  test('requires every imported review item before saving or activation', () => {
    const candidate = draft()
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a']).issues)
      .toContainEqual({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })
    candidate.config.agentsEnabled = true
    candidate.config.allowedModes = ['response', 'agentic']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a']).issues)
      .toContainEqual({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })
    candidate.reviewAcknowledgements = ['slot:a']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a']).valid).toBe(true)
    candidate.reviewAcknowledgements = ['slot:a', 'review:cognition_foreign_authority_blocked']
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['slot:a']).valid).toBe(true)
    expect(validateAgenticRuntimeDraft(candidate, [], 0, []).valid).toBe(true)
    expect(requiredReviewAcknowledgements(['slot:a'], candidate.reviewAcknowledgements))
      .toEqual(['slot:a', 'review:cognition_foreign_authority_blocked'])
    expect(requiredReviewAcknowledgements(['slot:a', 'review:foreign_import'], ['review:cognition_foreign_authority_blocked']))
      .toEqual(['slot:a', 'review:foreign_import'])
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['review:cognition_foreign_authority_blocked']).valid).toBe(true)
    candidate.reviewAcknowledgements = []
    expect(validateAgenticRuntimeDraft(candidate, [], 0, ['review:cognition_foreign_authority_blocked']).valid).toBe(false)
 
    const imported = presetWithMetadata({})
    imported.agentConfigReview = {
      state: 'review_required',
      revision: 1,
      reasonCode: 'foreign_import',
      unresolvedSlotIds: ['writer'],
      staleSlotIds: [],
      items: [{
        id: 'slot:writer',
        kind: 'unresolved_slot',
        reasonCode: 'unresolved_slot',
        action: { kind: 'map_slot' },
        acknowledged: false,
      }],
    }
    expect(getAgenticRuntimeRepairItems(imported).map((item) => item.id)).toEqual([
      'slot:writer',
      'review:foreign_import',
    ])
  })
  test('does not misclassify repair-required state as imported review', () => {
    const repairing = presetWithMetadata({})
    repairing.agentConfigReview = {
      state: 'repair_required',
      revision: 2,
      reasonCode: 'loom_reference_repair_required',
      unresolvedSlotIds: [],
      staleSlotIds: [],
      items: [],
    }
    expect(getAgenticRuntimeRepairItems(repairing)).toEqual([])
  })
  test('does not fabricate imported review for an empty non-import review state', () => {
    const reviewing = presetWithMetadata({})
    reviewing.agentConfigReview = {
      state: 'review_required',
      revision: 3,
      reasonCode: 'local_capability_review',
      unresolvedSlotIds: [],
      staleSlotIds: [],
      items: [],
    }
    expect(getAgenticRuntimeRepairItems(reviewing)).toEqual([])
  })

  test('does not fabricate imported review from malformed review data', () => {
    const malformed = presetWithMetadata({})
    malformed.agentConfigReview = 'malformed' as unknown as LoomPreset['agentConfigReview']
    expect(getAgenticRuntimeRepairItems(malformed)).toEqual([])
  })

  test('constructs disabled-import acknowledgement only from foreign-import review provenance', () => {
    const imported = presetWithMetadata({})
    imported.agentConfigReview = {
      state: 'review_required',
      revision: 4,
      reasonCode: 'foreign_import',
      unresolvedSlotIds: [],
      staleSlotIds: [],
      items: [],
    }
    expect(getAgenticRuntimeRepairItems(imported)).toEqual([{
      id: 'review:foreign_import',
      kind: 'disabled_import',
      label: 'foreign_import',
      reasonCode: 'foreign_import',
      action: { kind: 'acknowledge' },
      acknowledged: false,
    }])
  })
  test('preserves an acknowledged foreign-import item while another repair remains', () => {
    const imported = presetWithMetadata({})
    imported.agentConfigReview = {
      state: 'review_required',
      revision: 5,
      reasonCode: 'foreign_import',
      unresolvedSlotIds: ['writer'],
      staleSlotIds: [],
      items: [{
        id: 'review:foreign_import',
        kind: 'disabled_import',
        reasonCode: 'foreign_import',
        action: { kind: 'acknowledge' },
        acknowledged: true,
      }],
    }
    expect(getAgenticRuntimeRepairItems(imported)).toEqual([{
      id: 'slot:writer',
      kind: 'unresolved_slot',
      label: 'writer',
      reasonCode: 'unresolved_slot',
      action: { kind: 'map_slot' },
      acknowledged: false,
    }, {
      id: 'review:foreign_import',
      kind: 'disabled_import',
      label: 'foreign_import',
      reasonCode: 'foreign_import',
      action: { kind: 'acknowledge' },
      acknowledged: true,
    }])
  })
 
  test('accepts one internally consistent draft containing phase and task policy', () => {
    const candidate = draft()
    candidate.taskTemplates = [{
      id: 'verify_rules',
      label: 'Verify rules',
      required: true,
      dependencies: [],
      activation: { kind: 'all', children: [
        { kind: 'phase', value: 'WORK' },
        { kind: 'generation_type', value: 'normal' },
      ] },
    }]
    candidate.config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [createLoomPolicyEntryV1('workPolicy', block(3), 8, 0)],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    candidate.config.taskPolicy = { templateIds: ['verify_rules'] }
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8)).toEqual({ valid: true, issues: [] })
  })

  test('accepts every closed leaf predicate variant without false invalidation', () => {
    const candidate = draft()
    candidate.taskTemplates = [{
      id: 'verify_rules',
      required: true,
      activation: { kind: 'all', children: [
        { kind: 'preset_variable', name: 'mode', operator: 'present' },
        { kind: 'participant_fact', name: 'role', operator: 'equals', value: 'root' },
        { kind: 'tool_available', toolId: 'lore_list_books', available: true },
        { kind: 'task_transition', taskId: 'verify_rules', transition: 'active' },
      ] },
    }]
    candidate.config.taskPolicy = { templateIds: ['verify_rules'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).valid).toBe(true)
  })

  test('rejects non-finite predicate numbers before they enter an editor draft', () => {
    const candidate = draft()
    candidate.taskTemplates = [{
      id: 'finite_number',
      required: true,
      activation: { kind: 'preset_variable', name: 'score', operator: 'equals', value: Number.NaN },
    }]
    candidate.config.taskPolicy = { templateIds: ['finite_number'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_template', path: 'taskTemplates.0' })
  })

  test('matches backend cognition ceilings at exact predicate and task boundaries', () => {
    expect({
      depth: AGENTIC_PREDICATE_MAX_DEPTH,
      nodes: AGENTIC_PREDICATE_MAX_NODES,
      tasks: AGENTIC_TASK_TEMPLATE_LIMIT,
    }).toEqual({ depth: 16, nodes: 256, tasks: 256 })
 
    const nodeBoundary = draft()
    nodeBoundary.taskTemplates = [{
      id: 'node_boundary',
      required: true,
      activation: {
        kind: 'all',
        children: Array.from({ length: AGENTIC_PREDICATE_MAX_NODES - 1 }, () => ({ kind: 'phase' as const, value: 'WORK' as const })),
      },
    }]
    nodeBoundary.config.taskPolicy = { templateIds: ['node_boundary'] }
    expect(validateAgenticRuntimeDraft(nodeBoundary, [], 0).valid).toBe(true)
    const boundaryActivation = nodeBoundary.taskTemplates[0]!.activation
    if (boundaryActivation?.kind !== 'all') throw new Error('Expected all predicate')
    boundaryActivation.children.push({ kind: 'phase', value: 'WORK' })
    expect(validateAgenticRuntimeDraft(nodeBoundary, [], 0).issues.some((issue) => issue.code === 'predicate_limit_exceeded')).toBe(true)
    type BinaryPredicate =
      | { kind: 'phase'; value: 'WORK' }
      | { kind: 'all'; children: BinaryPredicate[] }
    const binaryPredicate = (depth: number): BinaryPredicate => depth === 0
      ? { kind: 'phase', value: 'WORK' }
      : { kind: 'all', children: [binaryPredicate(depth - 1), binaryPredicate(depth - 1)] }
    const farOverWidth = draft()
    farOverWidth.taskTemplates = [{ id: 'far_over_width', required: true, activation: binaryPredicate(9) }]
    farOverWidth.config.taskPolicy = { templateIds: ['far_over_width'] }
    expect(validateAgenticRuntimeDraft(farOverWidth, [], 0).issues)
      .toContainEqual({ code: 'predicate_limit_exceeded', path: 'taskTemplates.0.activation' })
 
    const taskBoundary = draft()
    taskBoundary.taskTemplates = Array.from({ length: AGENTIC_TASK_TEMPLATE_LIMIT }, (_value, index) => ({
      id: `task_${index}`,
      required: false,
    }))
    taskBoundary.config.taskPolicy = { templateIds: taskBoundary.taskTemplates.map((template) => template.id) }
    expect(validateAgenticRuntimeDraft(taskBoundary, [], 0).valid).toBe(true)
    taskBoundary.taskTemplates.push({ id: 'task_overflow', required: false })
    taskBoundary.config.taskPolicy.templateIds.push('task_overflow')
    expect(validateAgenticRuntimeDraft(taskBoundary, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_template', path: 'taskTemplates' })
  })
  test('classifies per-string predicate ceiling failures', () => {
    const longStringCandidate = draft()
    longStringCandidate.taskTemplates = [{
      id: 'long_string',
      required: true,
      activation: {
        kind: 'participant_fact',
        name: 'fact',
        operator: 'includes',
        value: 'x'.repeat(AGENTIC_PREDICATE_MAX_STRING_BYTES + 1),
      },
    }]
    longStringCandidate.config.taskPolicy = { templateIds: ['long_string'] }
    expect(validateAgenticRuntimeDraft(longStringCandidate, [], 0).issues)
      .toContainEqual({ code: 'predicate_limit_exceeded', path: 'taskTemplates.0.activation' })
 
    const longIdCandidate = draft()
    longIdCandidate.taskTemplates = [{
      id: 'long_id',
      required: true,
      activation: {
        kind: 'preset_variable',
        name: 'n'.repeat(257),
        operator: 'present',
      },
    }]
    longIdCandidate.config.taskPolicy = { templateIds: ['long_id'] }
    expect(validateAgenticRuntimeDraft(longIdCandidate, [], 0).issues)
      .toContainEqual({ code: 'predicate_limit_exceeded', path: 'taskTemplates.0.activation' })
  })
  test('enforces profile ceilings in the shared validator', () => {
    const candidate = draft()
    candidate.config.profiles = [{
      id: 'researcher',
      name: 'Researcher',
      systemPrompt: 'x'.repeat(AGENT_SYSTEM_PROMPT_MAX_BYTES + 1),
      connectionRef: { kind: 'inherit_main' },
      toolIds: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS_MAX + 1,
      timeoutMs: AGENT_TIMEOUT_MS_MIN + 1,
    }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })
  })

  test('accepts declared portable slots and rejects malformed or missing references', () => {
    const candidate = draft()
    candidate.config.connectionSlots = [{
      id: 'writer',
      label: 'Writer connection',
      requiredCapabilities: ['generation', 'streaming'],
    }]
    candidate.config.profiles = [{
      id: 'writer_agent',
      name: 'Writer',
      systemPrompt: '',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: false,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
    }]
    candidate.slotBindings = { writer: 'connection-1' }
    expect(validateAgenticRuntimeDraft(candidate, [], 0)).toEqual({ valid: true, issues: [] })

    candidate.config.connectionSlots = [
      { id: 'writer', label: 'Writer', requiredCapabilities: [] },
      { id: 'writer', label: 'Duplicate', requiredCapabilities: [] },
    ]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.connectionSlots.1.id' })

    candidate.config.connectionSlots = [{ id: 'writer', label: '', requiredCapabilities: ['unknown'] as never[] }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.connectionSlots.0' })

    candidate.config.connectionSlots = []
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_slot', path: 'config.profiles.0.connectionRef' })
  })

  test('rejects unknown closed-set tool, scope, and capability IDs', () => {
    const candidate = draft()
    candidate.config.mainToolIds = ['not_a_core_tool' as never]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_config', path: 'config.mainToolIds' })

    candidate.config.mainToolIds = []
    candidate.config.profiles = [{
      id: 'researcher',
      name: 'Researcher',
      systemPrompt: '',
      connectionRef: { kind: 'inherit_main' },
      toolIds: ['not_a_core_tool' as never],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: false,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
    }]
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })

    candidate.config.profiles[0]!.toolIds = []
    candidate.config.profiles[0]!.loreScope = 'unknown' as never
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_profile', path: 'config.profiles.0' })
  })

  test('requires task policy IDs to reference declared templates without filling omitted selections', () => {
    const candidate = draft()
    candidate.taskTemplates = [{ id: 'task_1', required: false }]
    candidate.config.taskPolicy = { templateIds: ['missing'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'config.taskPolicy.templateIds.0' })

    candidate.config.taskPolicy = { templateIds: ['task_1', 'task_1'] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'config.taskPolicy.templateIds.1' })

    candidate.config.taskPolicy = { templateIds: [] }
    expect(validateAgenticRuntimeDraft(candidate, [], 0).valid).toBe(true)
    delete candidate.config.taskPolicy
    expect(validateAgenticRuntimeDraft(candidate, [], 0).issues)
      .toContainEqual({ code: 'invalid_task_policy', path: 'config.taskPolicy' })
  })

  test('accepts a dormant backend config that omits optional policies', () => {
    const sparse = {
      version: 2 as const,
      agentsEnabled: false,
      allowedModes: ['response' as const],
      defaultMode: 'response' as const,
      maxInvocations: 64,
      maxToolCalls: 64,
      mainToolIds: [],
      mainLoreScope: 'active' as const,
      profiles: [],
      connectionSlots: [],
    }
    const candidate = draft()
    candidate.config = sparse
    expect(validateAgenticRuntimeDraft(candidate, [], 0)).toEqual({ valid: true, issues: [] })

    const hydrated = createAgenticRuntimeDraft({
      ...presetWithMetadata({}),
      agentConfig: sparse,
      blocks: [],
    })
    expect(hydrated.config.cognitionPolicy).toBeUndefined()
    expect(validateAgenticRuntimeDraft(hydrated, [], 0)).toEqual({ valid: true, issues: [] })
    expect(normalizeAgentConfigForEditor(sparse).taskPolicy).toEqual({ templateIds: [] })
  })
})
  test('quarantines malformed imported profiles and connection slots without fabricating runnable rows', () => {
    const agentConfig = {
      ...createDefaultAgentConfigV2(),
      profiles: [{ id: 'hostile', name: 'Hostile' }] as never[],
      connectionSlots: [{ id: 'hostile-slot', label: 'Hostile slot' }] as never[],
    }
    const hydrated = createAgenticRuntimeDraft({
      ...presetWithMetadata({}),
      agentConfig: agentConfig as never,
      blocks: [],
    })

    expect(hydrated.config.profiles).toEqual([])
    expect(hydrated.config.connectionSlots).toEqual([])
    expect(hydrated.quarantinedProfiles).toEqual([{
      id: 'invalid_profile:0',
      index: 0,
      reasonCode: 'invalid_profile',
    }])
    expect(hydrated.quarantinedConnectionSlots).toEqual([{
      id: 'invalid_slot:0',
      index: 0,
      reasonCode: 'invalid_slot',
    }])
    expect(validateAgenticRuntimeDraft(hydrated, [], 0).issues).toEqual(expect.arrayContaining([
      { code: 'invalid_profile', path: 'config.profiles.quarantine' },
      { code: 'invalid_slot', path: 'config.connectionSlots.quarantine' },
    ]))
  })

  test('uses code-point limits for profile names and connection-slot labels', () => {
    const acceptedConfig = createDefaultAgentConfigV2()
    const acceptedProfile = createAgentProfileV2('Agent', [])
    acceptedProfile.name = '😀'.repeat(AGENT_PROFILE_NAME_MAX_LENGTH)
    acceptedConfig.profiles = [acceptedProfile]
    acceptedConfig.connectionSlots = [{
      id: 'writer',
      label: '😀'.repeat(AGENT_PROFILE_NAME_MAX_LENGTH),
      requiredCapabilities: [],
    }]
    const accepted = createAgenticRuntimeDraft({
      ...presetWithMetadata({}),
      agentConfig: acceptedConfig,
      blocks: [],
    })
    expect(accepted.config.profiles).toHaveLength(1)
    expect(accepted.config.connectionSlots).toHaveLength(1)
    expect(accepted.quarantinedProfiles).toEqual([])
    expect(accepted.quarantinedConnectionSlots).toEqual([])

    const rejectedConfig = createDefaultAgentConfigV2()
    const rejectedProfile = createAgentProfileV2('Agent', [])
    rejectedProfile.name = '😀'.repeat(AGENT_PROFILE_NAME_MAX_LENGTH + 1)
    rejectedConfig.profiles = [rejectedProfile]
    rejectedConfig.connectionSlots = [{
      id: 'writer',
      label: '😀'.repeat(AGENT_PROFILE_NAME_MAX_LENGTH + 1),
      requiredCapabilities: [],
    }]
    const rejected = createAgenticRuntimeDraft({
      ...presetWithMetadata({}),
      agentConfig: rejectedConfig,
      blocks: [],
    })
    expect(rejected.config.profiles).toEqual([])
    expect(rejected.config.connectionSlots).toEqual([])
    expect(rejected.quarantinedProfiles).toHaveLength(1)
    expect(rejected.quarantinedConnectionSlots).toHaveLength(1)
  })
describe('Canonical Loom policy and custom phase contracts', () => {
  const buckets = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
  const destinations = {
    workPolicy: 'root_work',
    workspaceUsage: 'root_work',
    completionCriteria: 'completion_handoff',
    renderPolicy: 'render',
  } as const
  const checkpoints = {
    workPolicy: 'WORK',
    workspaceUsage: 'WORK',
    completionCriteria: 'PREPARE_COMMIT',
    renderPolicy: 'RENDER',
  } as const

  const source = (blockId = 'policy-block', promptOrder = 0) => ({
    kind: 'loom_block' as const,
    blockId,
    presetRevision: 8,
    blockRevision: 3,
    promptOrder,
  })

  const policyEntry = (
    bucket: (typeof buckets)[number],
    condition?: LoomPolicyEntryV1['condition'],
  ): LoomPolicyEntryV1 => ({
    version: 1,
    id: `${bucket}-entry`,
    source: source(),
    destination: destinations[bucket],
    checkpoint: checkpoints[bucket],
    required: true,
    visibility: 'work_only',
    ...(condition === undefined ? {} : { condition }),
  })
 
  const policyDocument = () => ({
    version: 1,
    workPolicy: [policyEntry('workPolicy')],
    workspaceUsage: [policyEntry('workspaceUsage', { kind: 'phase', value: 'WORK' })],
    completionCriteria: [policyEntry('completionCriteria', { kind: 'phase', value: 'COMPLETE' })],
    renderPolicy: [policyEntry('renderPolicy')],
  })


  const phase = (
    id: string,
    repeatLimit: number,
    nextPhaseIds: string[],
    includeSkip = true,
  ) => {
    const value: Record<string, unknown> = {
      version: 1,
      id,
      label: id,
      instructionRefs: [source()],
      required: true,
      enter: { kind: 'phase', value: 'WORK' },
      exit: { kind: 'phase', value: 'COMPLETE' },
      capabilityRequests: ['workspace_read', 'delegation'],
      repeatLimit,
      nextPhaseIds,
    }
    if (includeSkip) value.skip = { kind: 'phase', value: 'ASSEMBLE' }
    return value
  }

  test('counts duplicate-ID occurrences independently at the source reference ceiling', () => {
    const references = Array.from({ length: 513 }, (_, promptOrder) => source('duplicate-block', promptOrder))
    const phases = Array.from({ length: 9 }, (_, phaseIndex) => {
      const start = phaseIndex * 64
      return {
        version: 1,
        id: `phase_${phaseIndex}`,
        label: `phase_${phaseIndex}`,
        instructionRefs: references.slice(start, start + 64),
        required: true,
        enter: { kind: 'phase', value: 'WORK' },
        exit: { kind: 'phase', value: 'COMPLETE' },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: phaseIndex < 8 ? [`phase_${phaseIndex + 1}`] : [],
      }
    })
    expect(() => parseAgentRuntimePolicyV1({
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: null,
      phases,
    })).toThrow(/distinct block occurrences/)
  })

  test('parses the four fixed buckets and typed conditions', () => {
    const parsed = parseLoomPolicyBucketsV1(policyDocument())
    expect(Object.keys(parsed)).toEqual([
      'version',
      'workPolicy',
      'workspaceUsage',
      'completionCriteria',
      'renderPolicy',
    ])
    expect(parsed.workPolicy[0]).not.toHaveProperty('condition')
    expect(parsed.workspaceUsage[0]!.condition).toEqual({ kind: 'phase', value: 'WORK' })
    expect(parsed.completionCriteria[0]!.condition).toEqual({ kind: 'phase', value: 'COMPLETE' })
    expect(parsed.renderPolicy[0]).not.toHaveProperty('condition')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.workPolicy)).toBe(true)
  })
  test('surfaces custom-phase and Loom predicate budget failures at draft paths', () => {
    type BinaryPredicate =
      | { kind: 'phase'; value: 'WORK' }
      | { kind: 'all'; children: BinaryPredicate[] }
    const binaryPredicate = (depth: number): BinaryPredicate => depth === 0
      ? { kind: 'phase', value: 'WORK' }
      : { kind: 'all', children: [binaryPredicate(depth - 1), binaryPredicate(depth - 1)] }

    const phaseCandidate = draft()
    phaseCandidate.config.runtimePolicy!.phases = [{
      ...phase('phase_one', 0, []),
      enter: binaryPredicate(9),
    }] as never
    expect(validateAgenticRuntimeDraft(phaseCandidate, [block(3)], 8).issues)
      .toContainEqual({ code: 'predicate_limit_exceeded', path: 'config.runtimePolicy.phases.0.enter' })

    const loomCandidate = draft()
    loomCandidate.config.runtimePolicy!.loomPolicy = {
      version: 1,
      workPolicy: [policyEntry('workPolicy', {
        kind: 'all',
        children: Array.from({ length: AGENTIC_PREDICATE_MAX_NODES }, () => ({ kind: 'phase' as const, value: 'WORK' as const })),
      })],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    expect(validateAgenticRuntimeDraft(loomCandidate, [block(3)], 8).issues)
      .toContainEqual({
        code: 'predicate_limit_exceeded',
        path: 'config.runtimePolicy.loomPolicy.workPolicy.0.condition',
      })
  })


  test('constructor output obeys fixed routing and canonical source provenance', () => {
    for (const bucket of buckets) {
      const entry = createLoomPolicyEntryV1(bucket, block(3), 8, 0)
      const parsed = parseLoomPolicyBucketsV1({
        version: 1,
        workPolicy: bucket === 'workPolicy' ? [entry] : [],
        workspaceUsage: bucket === 'workspaceUsage' ? [entry] : [],
        completionCriteria: bucket === 'completionCriteria' ? [entry] : [],
        renderPolicy: bucket === 'renderPolicy' ? [entry] : [],
      })

      expect(parsed[bucket]).toEqual([entry])
      expect(entry.source).toEqual(source())
      expect(entry.destination).toBe(destinations[bucket])
      expect(entry.checkpoint).toBe(checkpoints[bucket])
    }
  })
  test('parses canonical runtime policies with optional phases through the shared parser', () => {
    const parsed = parseAgentRuntimePolicyV1({
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'agentic',
      loomPolicy: policyDocument(),
    })
    expect(parsed.phases).toEqual([])
    expect(parsed.loomPolicy).toEqual(parseLoomPolicyBucketsV1(policyDocument()))
    expect(() => parseAgentRuntimePolicyV1({
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'agentic',
      loomPolicy: policyDocument(),
      unexpected: true,
    })).toThrow(/unknown key/)
  })

  test('uses raw UTF-8 ordering for equal prompt-order Loom policy ties', () => {
    const entry = (id: string, blockId: string) => ({
      version: 1 as const,
      id,
      source: source(blockId, 0),
      destination: 'root_work' as const,
      checkpoint: 'WORK' as const,
      required: true,
      visibility: 'work_only' as const,
    })
    const parsed = parseLoomPolicyBucketsV1({
      version: 1,
      workPolicy: [entry('entry-accent', 'é'), entry('entry-latin', 'z')],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    })
    expect(parsed.workPolicy.map((policy) => policy.source.blockId)).toEqual(['z', 'é'])
  })

  test('evaluates scalar includes and array-valued in predicates with backend semantics', () => {
    const predicates = [
      {
        id: 'string-includes',
        blockId: 'string-fact',
        condition: { kind: 'participant_fact', name: 'tags', operator: 'includes', value: 'blue' },
      },
      {
        id: 'array-in',
        blockId: 'array-fact',
        condition: { kind: 'participant_fact', name: 'states', operator: 'in', values: ['selected'] },
      },
    ]
    const policies = {
      version: 1,
      workPolicy: predicates.map(({ id, blockId, condition }) => ({
        version: 1,
        id,
        source: source(blockId, 0),
        destination: 'root_work',
        checkpoint: 'WORK',
        required: true,
        visibility: 'work_only',
        condition,
      })),
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const inspection = inspectLoomPromptPoliciesV1(policies, {
      checkpoint: 'WORK',
      surface: 'WORK',
      evaluation: {
        generationType: 'normal',
        phase: 'WORK',
        presetVariables: {},
        participantFacts: {
          tags: ['blue'],
          states: ['selected', 'other'],
        },
        availableTools: [],
        taskTransitions: {},
      },
      blocks: predicates.map(({ blockId }) => ({
        source: source(blockId, 0),
        content: blockId,
      })),
    })

    expect(inspection.items).toHaveLength(predicates.length)
    expect(inspection.items.map((item) => item.outcome.status)).toEqual(
      predicates.map(() => 'included'),
    )
  })


  test('deep-freezes copied checkpoint inspection items and outcomes', () => {
    const nestedCondition: LoomPolicyEntryV1['condition'] = {
      kind: 'all',
      children: [{
        kind: 'participant_fact',
        name: 'tags',
        operator: 'in',
        values: ['selected'],
      }],
    }
    const entry = (
      id: string,
      blockId: string,
      promptOrder: number,
      required: boolean,
      condition?: LoomPolicyEntryV1['condition'],
    ): LoomPolicyEntryV1 => ({
      version: 1,
      id,
      source: source(blockId, promptOrder),
      destination: 'root_work',
      checkpoint: 'WORK',
      required,
      visibility: 'work_only',
      ...(condition === undefined ? {} : { condition }),
    })
    const policies = {
      version: 1,
      workPolicy: [
        entry('a-included', 'shared', 0, true, nestedCondition),
        entry('b-deduplicated', 'shared', 0, true),
        entry('c-skipped', 'skipped', 1, false, { kind: 'phase', value: 'RENDER' }),
        entry('d-rejected', 'missing', 2, true),
      ],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const inspection = inspectLoomPromptPoliciesV1(policies, {
      checkpoint: 'WORK',
      surface: 'WORK',
      evaluation: {
        generationType: 'normal',
        phase: 'WORK',
        presetVariables: {},
        participantFacts: { tags: 'selected' },
        availableTools: [],
        taskTransitions: {},
      },
      blocks: [
        { source: source('shared', 0), content: 'included content' },
        { source: source('skipped', 1), content: 'skipped content' },
      ],
    })

    expect(inspection.items.map((item) => item.outcome.status)).toEqual([
      'included',
      'deduplicated',
      'skipped',
      'rejected',
    ])
    expect(Object.isFrozen(inspection)).toBe(true)
    expect(Object.isFrozen(inspection.items)).toBe(true)
    expect(Object.isFrozen(inspection.effectiveEntryIds)).toBe(true)
    for (const item of inspection.items) {
      expect(Object.isFrozen(item)).toBe(true)
      expect(Object.isFrozen(item.outcome)).toBe(true)
      expect(Object.isFrozen(item.source)).toBe(true)
    }

    const included = inspection.items[0]!
    expect(included.source).not.toBe(policies.workPolicy[0]!.source)
    expect(included.condition).not.toBe(nestedCondition)
    expect(Object.isFrozen(included.condition)).toBe(true)
    if (included.condition?.kind !== 'all') throw new Error('expected nested all condition')
    expect(Object.isFrozen(included.condition.children)).toBe(true)
    const nestedFact = included.condition.children[0]!
    expect(Object.isFrozen(nestedFact)).toBe(true)
    if (nestedFact.kind !== 'participant_fact' || nestedFact.operator !== 'in') {
      throw new Error('expected nested participant_fact in condition')
    }
    expect(Object.isFrozen(nestedFact.values)).toBe(true)

    const originalItem = inspection.items[0]
    const originalOutcome = included.outcome
    const originalNestedFact = included.condition.children[0]
    expect(Reflect.set(inspection.items, 0, inspection.items[1])).toBe(false)
    expect(Reflect.set(included, 'entryId', 'tampered')).toBe(false)
    expect(Reflect.set(included, 'outcome', { status: 'rejected', reason: 'invalid_source' })).toBe(false)
    expect(Reflect.set(originalOutcome, 'status', 'rejected')).toBe(false)
    expect(Reflect.set(included.source, 'blockId', 'tampered')).toBe(false)
    expect(Reflect.set(included.condition.children, 0, { kind: 'phase', value: 'RENDER' })).toBe(false)
    expect(Reflect.set(nestedFact.values, 0, 'tampered')).toBe(false)
    expect(Reflect.set(policies.workPolicy[0]!.source, 'blockId', 'later-edit')).toBe(true)

    expect(inspection.items[0]).toBe(originalItem)
    expect(included.entryId).toBe('a-included')
    expect(included.outcome).toBe(originalOutcome)
    expect(included.outcome.status).toBe('included')
    expect(included.source.blockId).toBe('shared')
    expect(included.condition.children[0]).toBe(originalNestedFact)
    expect(nestedFact.values).toEqual(['selected'])
  })
  test('rejects aliases, fifth buckets, and malformed exact references', () => {
    const valid = policyDocument()
    const malformedReference = {
      ...valid,
      workPolicy: [{
        ...valid.workPolicy[0],
        source: { ...valid.workPolicy[0]!.source, unexpected: [] },
      }],
    }

    expect(() => parseLoomPolicyBucketsV1(malformedReference)).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({ ...valid, work: [] })).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({ ...valid, fifthBucket: [] })).toThrow(/unknown key/)
    expect(() => parseLoomPolicyBucketsV1({
      ...valid,
      renderPolicy: [{ ...valid.renderPolicy[0], unexpected: true }],
    })).toThrow(/unknown key/)
  })

  test('rejects sparse policy, phase, predicate, and malformed revision inputs', () => {
    const sparsePolicy = policyDocument() as Record<string, unknown>
    sparsePolicy.workPolicy = new Array(1)
    expect(() => parseLoomPolicyBucketsV1(sparsePolicy)).toThrow(/dense array/)

    const sparsePhases = new Array(1)
    expect(() => parseAgentCustomPhasesV1(sparsePhases)).toThrow(/ordered phases/)

    const sparsePredicate = policyDocument()
    sparsePredicate.workspaceUsage = [policyEntry('workspaceUsage', {
      kind: 'all',
      children: new Array(1),
    })]
    expect(() => parseLoomPolicyBucketsV1(sparsePredicate)).toThrow(/invalid predicate/)

    for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
      const entry = createLoomPolicyEntryV1(
        'workPolicy',
        { ...block(3), revision },
        8,
        0,
      )
      expect(entry.source.blockRevision).toBe(revision)
    }
    const missingRevision = createLoomPolicyEntryV1(
      'workPolicy',
      { ...block(3), revision: undefined },
      8,
      0,
    )
    expect(missingRevision.source.blockRevision).toBe(1)
    expect(() => createLoomPolicyEntryV1(
      'workPolicy',
      { ...block(3), revision: -1 },
      8,
      0,
    )).toThrow(/non-negative safe integer/)
    expect(() => parseLoomPolicyBucketsV1({
      ...policyDocument(),
      workPolicy: [{
        ...policyDocument().workPolicy[0],
        source: { ...source(), blockRevision: -1 },
      }],
    })).toThrow(/non-negative safe integer/)
    expect(parseLoomPolicyBucketsV1({
      ...policyDocument(),
      workPolicy: [{
        ...policyDocument().workPolicy[0],
        source: { ...source(), presetRevision: 0, blockRevision: 0 },
      }],
    }).workPolicy[0]!.source).toMatchObject({ presetRevision: 0, blockRevision: 0 })
  })

  test('uses backend Unicode label bounds and permits empty predicate groups', () => {
    for (const label of ['', '😀'.repeat(80), 'a'.repeat(80)]) {
      const parsed = parseAgentCustomPhasesV1([{
        ...phase('labelled', 0, [], false),
        label,
      }])
      expect(parsed[0]!.label).toBe(label)
    }
    expect(() => parseAgentCustomPhasesV1([{
      ...phase('labelled', 0, [], false),
      label: '😀'.repeat(81),
    }])).toThrow(/characters/)
    const parsed = parseAgentCustomPhasesV1([{
      ...phase('empty_predicates', 0, [], false),
      enter: { kind: 'all', children: [] },
      exit: { kind: 'any', children: [] },
    }])
    expect(parsed[0]!.enter).toEqual({ kind: 'all', children: [] })
    expect(parsed[0]!.exit).toEqual({ kind: 'any', children: [] })
  })

  test('parses canonical custom phases with optional skip and repeat boundaries', () => {
    const parsed = parseAgentCustomPhasesV1([
      phase('phase_one', 0, []),
      phase('phase_two', 4, [], false),
    ])

    expect(parsed.map((entry) => entry.id)).toEqual(['phase_one', 'phase_two'])
    expect(parsed.map((entry) => entry.repeatLimit)).toEqual([0, 4])
    expect(parsed[0]!.instructionRefs).toEqual([source()])
    expect(parsed[0]!.skip).toEqual({ kind: 'phase', value: 'ASSEMBLE' })
    expect(parsed[1]).not.toHaveProperty('skip')
    expect(Object.keys(parsed[0]!)).toEqual([
      'version',
      'id',
      'label',
      'instructionRefs',
      'childInstructionSubsets',
      'required',
      'enter',
      'exit',
      'skip',
      'capabilityRequests',
      'repeatLimit',
      'nextPhaseIds',
    ])
  })

  test('rejects duplicate IDs, duplicate or non-exact refs, closed-set capability violations, and bad repeats', () => {
    const canonical = phase('phase_one', 1, ['phase_one'])
    expect(() => parseAgentCustomPhasesV1([
      phase('phase_zero_repeat', 0, ['phase_zero_repeat']),
    ])).toThrow(/config\.runtimePolicy\.phases\.0\.nextPhaseIds: self transition requires repeatLimit greater than zero/)
    expect(() => parseAgentCustomPhasesV1([
      canonical,
      phase('phase_one', 4, ['phase_one']),
    ])).toThrow(/duplicate custom phase id/)

    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      instructionRefs: [source(), { ...source(), blockRevision: 2 }],
    }])).toThrow(/duplicate instruction reference/)
    expect(parseAgentCustomPhasesV1([{
      ...canonical,
      instructionRefs: [source('policy-block', 0), source('policy-block', 1)],
    }])[0]!.instructionRefs).toHaveLength(2)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      instructionRefs: [{ ...source(), legacyAlias: true }],
    }])).toThrow(/unknown key/)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      capabilityRequests: ['workspace_read', 'workspace_read'],
    }])).toThrow(/duplicate capability request/)
    expect(() => parseAgentCustomPhasesV1([{
      ...canonical,
      capabilityRequests: ['unknown_capability'],
    }])).toThrow(/unsupported capability request/)

    for (const repeatLimit of [-1, 5, 1.5]) {
      expect(() => parseAgentCustomPhasesV1([
        phase('phase_one', repeatLimit, []),
      ])).toThrow(/repeatLimit/)
    }
  })

  test('validates self and immediate-next transitions but rejects a farther jump', () => {
    const candidate = draft()
    const validPhases = parseAgentCustomPhasesV1([
      phase('phase_one', 1, ['phase_one', 'phase_two']),
      phase('phase_two', 4, ['phase_two']),
    ])
    candidate.config.runtimePolicy = {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: null,
      phases: validPhases,
    }
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8)).toEqual({ valid: true, issues: [] })
    candidate.config.runtimePolicy.phases = [
      phase('phase_one', 0, ['phase_one']) as never,
      phase('phase_two', 4, ['phase_two']) as never,
    ]
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8).issues)
      .toContainEqual({
        code: 'invalid_policy_entry',
        path: 'config.runtimePolicy.phases.0.repeatLimit',
      })


    candidate.config.runtimePolicy.phases = parseAgentCustomPhasesV1([
      phase('phase_one', 1, ['phase_one', 'phase_three']),
      phase('phase_two', 4, ['phase_two']),
    ])
    expect(validateAgenticRuntimeDraft(candidate, [block(3)], 8).issues)
      .toContainEqual({
        code: 'invalid_policy_entry',
        path: 'config.runtimePolicy.phases.0.nextPhaseIds.1',
      })
  })

  test('preserves malformed authored policy and never revives legacy cognition beside canonical authority', () => {
    const legacyReference = {
      workPolicy: [{ blockId: 'policy-block', expectedPresetRevision: 8, expectedBlockRevision: 3 }],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const malformedRuntimePolicy = {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: { version: 1, workPolicy: null },
      phases: null,
    }
    const authored = {
      ...createDefaultAgentConfigV2(),
      cognitionPolicy: legacyReference,
      runtimePolicy: malformedRuntimePolicy,
    }

    const hydrated = normalizeAgentConfigForEditor(authored as never) as unknown as Record<string, unknown>
    expect(hydrated.runtimePolicy).toEqual(malformedRuntimePolicy)
    expect(hydrated.cognitionPolicy).toEqual(legacyReference)
    expect(getAgentRuntimePolicyBuckets(authored, [block(3)])).toEqual({
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    })
  })

  test('emits runtimePolicy without legacy cognition or an extra bucket', () => {
    const config = createDefaultAgentConfigV2()
    config.cognitionPolicy = {
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const policies = parseLoomPolicyBucketsV1(policyDocument())
    const emitted = setAgentRuntimePolicyBuckets(config, policies)

    expect(emitted).not.toHaveProperty('cognitionPolicy')
    expect(Object.keys(emitted.runtimePolicy!)).toEqual([
      'version',
      'authority',
      'scope',
      'defaultMode',
      'loomPolicy',
      'phases',
    ])
    expect(Object.keys(emitted.runtimePolicy!.loomPolicy!)).toEqual([
      'version',
      'workPolicy',
      'workspaceUsage',
      'completionCriteria',
      'renderPolicy',
    ])
    expect(emitted.runtimePolicy!.loomPolicy).toEqual(policies)

    const phases = parseAgentCustomPhasesV1([phase('phase_one', 1, ['phase_one'])])
    const emittedPhases = setAgentRuntimeCustomPhases(config, phases)
    expect(emittedPhases).not.toHaveProperty('cognitionPolicy')
    expect(Object.keys(emittedPhases.runtimePolicy!)).toEqual([
      'version',
      'authority',
      'scope',
      'defaultMode',
      'loomPolicy',
      'phases',
    ])
    expect(emittedPhases.runtimePolicy!.phases).toEqual(phases)
  })
})
