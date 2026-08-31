import { describe, expect, test } from 'bun:test'
import type { AgentConfigV2, LoomPreset } from './types'
import type {
  PortableAgentConfigV1,
  PortableAgenticRuntimeEnvelopeV1,
} from './service'
import {
  AGENTIC_PREDICATE_MAX_LIST_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_ITEMS,
  AGENTIC_PREDICATE_MAX_NODES,
  AGENTIC_PREDICATE_MAX_STRING_BYTES,
  parseAgentRuntimePolicyV1,
} from './agenticRuntime'
import {
  coerceImportedLoomPreset,
  createEmptyPortableAgenticRuntimeEnvelope,
  createNewLoomPreset,
  createPortableLoomExportPayload,
  sanitizeLumiHubSealedBlocksForExport,
  extractPortableAgenticRuntimeEnvelope,
  marshalPreset,
  isPortableAgenticRuntimeEnvelope,
  marshalUpdate,
  parsePortableAgenticRuntimeEnvelope,
  shouldRollbackImportedPreset,
  stripPortableRegexOwnership,
  toPortableAgentConfigV1,
  unmarshalPreset,
} from './service'
import type { Preset } from '@/types/api'


function portableConfig(): PortableAgentConfigV1 {
  return {
    portableVersion: 1,
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'agentic',
    maxInvocations: 4,
    maxToolCalls: 8,
    mainToolIds: ['chat_search_history'],
    mainLoreScope: 'active',
    profiles: [{
      id: 'writer',
      name: 'Writer',
      systemPrompt: 'Write the answer.',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      workspaceCapabilities: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
    }],
    connectionSlots: [{
      id: 'writer',
      label: 'Writer connection',
      requiredCapabilities: ['generation', 'streaming'],
    }],
    taskPolicy: { templateIds: ['write'] },
  }
}

function envelope(): PortableAgenticRuntimeEnvelopeV1 {
  return {
    version: 1,
    agentConfig: portableConfig(),
    taskTemplates: [{ id: 'write', required: true, label: 'Write' }],
  }
}

function localPreset(): LoomPreset {
  const preset = createNewLoomPreset('Portable')
  const localConfig: AgentConfigV2 = {
    version: 2,
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'agentic',
    maxInvocations: 4,
    maxToolCalls: 8,
    mainToolIds: ['chat_search_history'],
    mainLoreScope: 'active',
    profiles: [{
      id: 'writer',
      name: 'Writer',
      systemPrompt: 'Write the answer.',
      connectionRef: { kind: 'slot', slotId: 'writer' },
      toolIds: [],
      workspaceCapabilities: [],
      loreScope: 'active',
      allowMainDelegation: false,
      failurePolicy: 'required',
      streamActivity: true,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
    }],
    connectionSlots: [{ id: 'writer', label: 'Writer', requiredCapabilities: ['generation', 'streaming'] }],
  }
  preset.agentConfig = localConfig
  preset.agentSlotBindings = { writer: 'local-connection-id' }
  preset.agentConfigReview = {
    state: 'ready',
    revision: 4,
    reasonCode: null,
    unresolvedSlotIds: [],
    staleSlotIds: [],
    acknowledged: true,
    items: [],
  }
  preset.passthroughMetadata = {
    agentConfig: {
      version: 1,
      enabled: true,
      maxInvocations: 4,
      maxToolCalls: 8,
      mainToolIds: [],
      mainLoreScope: 'active',
      profiles: [],
    },
    agentConfigReviewRequired: true,
    extension: { preserve: true },
  }
  return preset
}

function runtimeSource(blockId: string, promptOrder = 0, blockRevision = 1): Record<string, unknown> {
  return {
    kind: 'loom_block',
    blockId,
    presetRevision: 0,
    blockRevision,
    promptOrder,
  }
}

function runtimeLoomPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    workPolicy: [],
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: [],
    ...overrides,
  }
}

function runtimePolicyEntry(
  id: string,
  source: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id,
    source,
    destination: 'root_work',
    checkpoint: 'WORK',
    required: true,
    visibility: 'work_only',
    ...overrides,
  }
}

function runtimePhase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    label: id,
    instructionRefs: [],
    childInstructionSubsets: [],
    required: true,
    enter: { kind: 'phase', value: 'WORK' },
    exit: { kind: 'phase', value: 'COMPLETE' },
    capabilityRequests: [],
    repeatLimit: 0,
    nextPhaseIds: [],
    ...overrides,
  }
}

function runtimePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: 'agentic',
    loomPolicy: runtimeLoomPolicy(),
    phases: [],
    ...overrides,
  }
}

function envelopeWithRuntimePolicy(runtimePolicyValue: unknown): PortableAgenticRuntimeEnvelopeV1 {
  return {
    ...envelope(),
    agentConfig: {
      ...portableConfig(),
      runtimePolicy: runtimePolicyValue,
    } as PortableAgentConfigV1,
  }
}


describe('Loom portable Agentic runtime adapter', () => {
  test('exports the canonical V2 envelope without local IDs, bindings, or legacy metadata', () => {
    const payload = createPortableLoomExportPayload(localPreset(), envelope())
    const metadata = payload.passthroughMetadata as Record<string, unknown>

    expect(payload.agentRuntime).toEqual(envelope())
    expect(payload).not.toHaveProperty('agentConfig')
    expect(payload).not.toHaveProperty('agentSlotBindings')
    expect(payload).not.toHaveProperty('agentConfigReview')
    expect(metadata).not.toHaveProperty('agentConfig')
    expect(metadata).not.toHaveProperty('agentConfigReviewRequired')
    expect(JSON.stringify(payload)).not.toContain('local-connection-id')
    expect(metadata.extension).toEqual({ preserve: true })
  })
  test('carries the backend engine while removing local installation identity', () => {
    const preset = localPreset()
    preset.engine = 'agentic'
    const payload = createPortableLoomExportPayload(preset, envelope())
    expect(payload.engine).toBe('agentic')
    const marshaled = marshalPreset(preset)
    expect(marshaled.engine).toBe('agentic')
    const restored = unmarshalPreset({
      id: preset.id,
      name: preset.name,
      provider: 'loom',
      engine: marshaled.engine ?? 'classic',
      parameters: marshaled.parameters ?? {},
      prompt_order: marshaled.prompt_order ?? [],
      prompts: marshaled.prompts ?? {},
      metadata: marshaled.metadata ?? {},
      created_at: preset.createdAt,
      updated_at: preset.updatedAt,
    })
    expect(restored.engine).toBe('agentic')
    expect(marshalUpdate(restored).engine).toBe('agentic')
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('lumihubMeta')
    expect(JSON.stringify(payload)).not.toContain(preset.id)
  })

  test('rejects non-string prompt block content before persistence', () => {
    const preset = localPreset()
    preset.blocks[0] = { ...preset.blocks[0], content: 42 as unknown as string }
    expect(() => marshalPreset(preset)).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
  })
  test('accepts optional prompt names and validates nested variable boundaries before persistence', () => {
    const withoutName = localPreset()
    const importedBlock = { ...withoutName.blocks[0] } as Record<string, unknown>
    delete importedBlock.name
    const imported = coerceImportedLoomPreset({
      ...withoutName,
      blocks: [importedBlock, withoutName.blocks[1]],
    }, 'Imported')
    expect(imported.blocks[0]).not.toHaveProperty('name')

    const presetWith = (patch: Record<string, unknown>): LoomPreset => {
      const preset = localPreset()
      preset.blocks[0] = {
        ...preset.blocks[0],
        ...patch,
      } as unknown as LoomPreset['blocks'][number]
      return preset
    }
    const invalidVariables: Record<string, unknown>[] = [
      { variables: null },
      {
        variables: [{
          id: 'tone',
          name: 'tone',
          label: 'Tone',
          type: 'text',
          defaultValue: null,
        }],
      },
      {
        variables: [{
          id: 'count',
          name: 'count',
          label: 'Count',
          type: 'number',
          defaultValue: Number.NaN,
        }],
      },
      {
        variables: [{
          id: 'choice',
          name: 'choice',
          label: 'Choice',
          type: 'select',
          defaultValue: 'missing',
          options: [{ id: 'one', label: 'One', value: 'one' }],
        }],
      },
      {
        variables: [{
          id: 'choices',
          name: 'choices',
          label: 'Choices',
          type: 'multiselect',
          defaultValue: ['one', 'one'],
          options: [{ id: 'one', label: 'One', value: 'one' }],
        }],
      },
    ]
    for (const invalid of invalidVariables) {
      expect(() => marshalPreset(presetWith(invalid))).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
    }

    const sparseVariables: unknown[] = []
    sparseVariables.length = 2
    expect(() => marshalPreset(presetWith({ variables: sparseVariables }))).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
    expect(() => marshalPreset(presetWith({ variables: new Array(1_000_000_000) }))).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
    expect(() => marshalPreset(presetWith({ injectionTrigger: new Array(1_000_000_000) }))).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
    expect(() => marshalPreset(presetWith({
      variables: [{
        id: 'text',
        name: 'text',
        label: 'Text',
        type: 'text',
        defaultValue: 'x'.repeat(AGENTIC_PREDICATE_MAX_LIST_BYTES + 1),
      }],
    }))).toThrow('PORTABLE_PROMPT_BLOCK_INVALID')
  })
  test('rejects ambiguous prompt identities before portable preset creation', () => {
    const base = localPreset()
    const textVariable = (id: string, name: string) => ({
      id,
      name,
      label: name,
      type: 'text' as const,
      defaultValue: '',
    })
    const firstBlock = base.blocks[0]!
    const secondBlock = base.blocks[1]!
    const invalidCases: Array<{ blocks: LoomPreset['blocks']; error: string }> = [
      {
        blocks: [{ ...firstBlock, id: '' }, secondBlock],
        error: 'block id must be non-empty',
      },
      {
        blocks: [firstBlock, { ...secondBlock, id: firstBlock.id }],
        error: 'duplicate block id',
      },
      {
        blocks: [{
          ...firstBlock,
          variables: [
            textVariable('same-id', 'tone'),
            textVariable('same-id', 'voice'),
          ],
        }, secondBlock],
        error: 'duplicate variable id',
      },
      {
        blocks: [{
          ...firstBlock,
          variables: [
            textVariable('tone-id', 'same-name'),
            textVariable('voice-id', 'same-name'),
          ],
        }, secondBlock],
        error: 'duplicate variable name',
      },
    ]
    const backendPayload = marshalPreset(base)
    const shapes = ['raw', 'wrapped', 'backend'] as const
    const payloadFor = (
      blocks: LoomPreset['blocks'],
      shape: typeof shapes[number],
    ): unknown => {
      if (shape === 'wrapped') {
        return {
          type: 'lumiverse_preset',
          preset: { ...base, blocks },
        }
      }
      if (shape === 'backend') {
        return { ...backendPayload, prompt_order: blocks }
      }
      return { ...base, blocks }
    }

    let persistenceCalls = 0
    const persist = (preset: LoomPreset) => {
      persistenceCalls += 1
      return marshalPreset(preset)
    }

    for (const shape of shapes) {
      for (const invalid of invalidCases) {
        expect(() => persist(coerceImportedLoomPreset(
          payloadFor(invalid.blocks, shape),
          'Imported',
        ))).toThrow(invalid.error)
      }
    }
    expect(persistenceCalls).toBe(0)

    const validBlocks: LoomPreset['blocks'] = [{
      ...firstBlock,
      variables: [
        textVariable('tone-id', 'tone'),
        textVariable('voice-id', 'voice'),
      ],
    }, secondBlock]
    for (const shape of shapes) {
      expect(() => persist(coerceImportedLoomPreset(
        payloadFor(validBlocks, shape),
        'Imported',
      ))).not.toThrow()
    }
    expect(persistenceCalls).toBe(shapes.length)
  })


  test('accepts valid prompt arrays at the backend item boundary', () => {
    const preset = localPreset()
    preset.blocks[0] = {
      ...preset.blocks[0],
      injectionTrigger: Array.from({ length: AGENTIC_PREDICATE_MAX_LIST_ITEMS }, (_, index) => `trigger-${index}`),
      characterTagTrigger: Array.from({ length: AGENTIC_PREDICATE_MAX_LIST_ITEMS }, (_, index) => `tag-${index}`),
      variables: Array.from({ length: AGENTIC_PREDICATE_MAX_LIST_ITEMS }, (_, index) => ({
        id: `variable-${index}`,
        name: `variable-${index}`,
        label: `Variable ${index}`,
        type: 'text' as const,
        defaultValue: '',
      })),
    }
    expect(() => marshalPreset(preset)).not.toThrow()
  })
  test('creates a canonical inert runtime envelope for descriptor-only sealed imports', () => {
    const runtime = createEmptyPortableAgenticRuntimeEnvelope()
    expect(parsePortableAgenticRuntimeEnvelope(runtime)).toEqual(runtime)
    expect(runtime).toEqual({
      version: 1,
      agentConfig: null,
      taskTemplates: [],
    })
  })
  test('distinguishes local sealed publishing opt-in from foreign sealed provenance', () => {
    const local = localPreset()
    local.blocks[0] = {
      ...local.blocks[0],
      content: 'local publisher secret',
      sealed: true,
      sealedKey: 'local-key',
    }
    expect(() => marshalUpdate(local)).not.toThrow()
    expect(() => sanitizeLumiHubSealedBlocksForExport(local)).not.toThrow()
    expect(() => marshalPreset(local)).toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')

    const foreign = localPreset()
    foreign.blocks[0] = {
      ...foreign.blocks[0],
      content: 'installed secret',
      sealed: true,
      sealedSource: 'lumihub',
      sealedKey: 'foreign-key',
    }
    expect(() => marshalUpdate(foreign)).toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
    expect(() => sanitizeLumiHubSealedBlocksForExport(foreign))
      .toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  })


  test('exports sealed blocks only as placeholders with a complete trusted descriptor', () => {
    const preset = localPreset()
    const sealedBlock = {
      ...preset.blocks[0],
      content: 'secret sealed text',
      sealed: true,
      sealedSource: 'lumihub' as const,
      sealedKey: 'private-system',
    }
    preset.blocks[0] = sealedBlock
    preset.lumihubMeta = {
      _lumiverse_lumihub_id: 'hub-preset-1',
      _lumiverse_sealed_preset: {
        version: '7',
        blocks: [{ key: 'private-system', sha256: 'a'.repeat(64) }],
      },
    }
    const payload = createPortableLoomExportPayload(preset, envelope())
    expect((payload.blocks as Array<Record<string, unknown>>)[0].content).toBe('{{presetBlock::private-system}}')
    expect(payload.portableSealedPreset).toEqual({
      hubPresetId: 'hub-preset-1',
      hubPresetVersion: '7',
      blocks: [{ key: 'private-system', sha256: 'a'.repeat(64) }],
    })
    expect(JSON.stringify(payload)).not.toContain('secret sealed text')
    expect(payload).not.toHaveProperty('lumihubMeta')
  })
  test('rejects a descriptor with missing sealed flags instead of exporting plaintext', () => {
    const preset = localPreset()
    preset.blocks[0] = {
      ...preset.blocks[0],
      content: 'plaintext that must not escape',
    }
    preset.portableSealedPreset = {
      hubPresetId: 'hub-preset-1',
      hubPresetVersion: '7',
      blocks: [{ key: preset.blocks[0].id, sha256: 'a'.repeat(64) }],
    }
    expect(() => createPortableLoomExportPayload(preset, envelope()))
      .toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  })
  test('rejects missing and unreferenced descriptor keys before export', () => {
    const preset = localPreset()
    preset.blocks[0] = {
      ...preset.blocks[0],
      content: 'secret sealed text',
      sealed: true,
      sealedSource: 'lumihub',
      sealedKey: 'private-system',
    }
    const descriptor = {
      hubPresetId: 'hub-preset-1',
      hubPresetVersion: '7',
      blocks: [{ key: 'other-key', sha256: 'a'.repeat(64) }],
    }
    preset.portableSealedPreset = descriptor
    expect(() => createPortableLoomExportPayload(preset, envelope()))
      .toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')

    preset.portableSealedPreset = {
      ...descriptor,
      blocks: [
        { key: 'private-system', sha256: 'a'.repeat(64) },
        { key: 'unreferenced', sha256: 'b'.repeat(64) },
      ],
    }
    expect(() => createPortableLoomExportPayload(preset, envelope()))
      .toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  })

  test('rejects sealed export when trusted origin or digest metadata is incomplete', () => {
    const preset = localPreset()
    preset.blocks[0] = {
      ...preset.blocks[0],
      sealed: true,
      sealedSource: 'lumihub',
      sealedKey: 'private-system',
    }
    preset.lumihubMeta = { _lumiverse_lumihub_id: 'hub-preset-1' }
    expect(() => createPortableLoomExportPayload(preset, envelope())).toThrow('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
  })
  test('preserves inert bounded legacy cognition without treating authority-looking keys as executable', () => {
    const cognitionPolicy = {
      workPolicy: [{ grant: 'owner', acl: ['read'], secret: 'opaque' }],
      nested: { grant: { acl: ['write'], secret: 'opaque' } },
    }
    const payload = {
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        cognitionPolicy,
      } as PortableAgentConfigV1,
    }

    const parsed = parsePortableAgenticRuntimeEnvelope(payload)
    expect(parsed.agentConfig.cognitionPolicy).toEqual(cognitionPolicy)
  })
  test('strips source-local regex identity, ownership, and validation metadata', () => {
    const scripts = stripPortableRegexOwnership([{
      id: 'local-row-id',
      script_id: 'portable-script',
      user_id: 'source-user',
      userId: 'source-user-camel',
      pack_id: 'source-pack',
      packId: 'source-pack-camel',
      preset_id: 'source-preset',
      presetId: 'source-preset-camel',
      character_id: 'source-character',
      characterId: 'source-character-camel',
      owner_extension_identifier: 'source-extension',
      ownerExtensionIdentifier: 'source-extension-camel',
      validation_error_code: 'invalid',
      validationErrorCode: 'invalid-camel',
      created_at: 1,
      createdAt: 1,
      updated_at: 2,
      updatedAt: 2,
      scope: 'preset',
      scope_id: 'source-preset',
      scopeId: 'source-preset-camel',
      find_regex: 'x',
    }])
    const script = scripts[0]
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
    ]) {
      expect(script).not.toHaveProperty(field)
    }
    expect(script.script_id).toBe('portable-script')
    expect(script.scope).toBe('global')
    expect(script.scope_id).toBeNull()
    expect(script.find_regex).toBe('x')
  })

  test('does not delete a committed portable import after hydration or selection failure', () => {
    expect(shouldRollbackImportedPreset('imported-preset', true)).toBe(false)
    expect(shouldRollbackImportedPreset('created-preset', false)).toBe(true)
    expect(shouldRollbackImportedPreset(null, true)).toBe(false)
  })

  test('accepts server-authored foreign slots and preserves the returned disabled review state', () => {
    const foreign = envelope()
    const parsed = parsePortableAgenticRuntimeEnvelope(foreign)
    expect(parsed.agentConfig?.profiles[0]?.connectionRef).toEqual({ kind: 'slot', slotId: 'writer' })
    expect(parsed.agentConfig?.profiles[0]).not.toHaveProperty('connectionProfileId')

    const preset: Preset = {
      id: 'foreign-preset',
      name: 'Foreign',
      provider: 'loom',
      engine: 'classic',
      parameters: {},
      prompt_order: [],
      prompts: {},
      metadata: {},
      agent_config: {
        ...localPreset().agentConfig!,
        agentsEnabled: false,
        allowedModes: ['response'],
        defaultMode: 'response',
      },
      agent_config_review: {
        state: 'review_required',
        revision: 1,
        reasonCode: 'foreign_import',
        unresolvedSlotIds: ['writer'],
        staleSlotIds: [],
        acknowledged: false,
        items: [],
      },
      created_at: 1,
      updated_at: 1,
    }
    const imported = unmarshalPreset(preset)
    expect(imported.agentConfig?.agentsEnabled).toBe(false)
    expect(imported.agentConfig?.allowedModes).toEqual(['response'])
    expect(imported.agentConfigReview?.unresolvedSlotIds).toEqual(['writer'])
  })

  test('accepts canonical runtimePolicy emitted by the portable config converter and rejects malformed policy', () => {
    const config = {
      ...localPreset().agentConfig!,
      runtimePolicy: {
        version: 1 as const,
        authority: 'loom' as const,
        scope: 'preset' as const,
        defaultMode: 'agentic' as const,
        loomPolicy: {
          version: 1 as const,
          workPolicy: [],
          workspaceUsage: [],
          completionCriteria: [],
          renderPolicy: [],
        },
        phases: [],
      },
      taskPolicy: { templateIds: ['write'] },
    } satisfies AgentConfigV2
    const portable = toPortableAgentConfigV1(config)
    const parsed = parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: portable,
    })
    expect(parsed.agentConfig).toEqual(portable)
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: {
        ...portable,
        runtimePolicy: {
          ...portable.runtimePolicy!,
          loomPolicy: {
            ...portable.runtimePolicy!.loomPolicy!,
            workPolicy: [{ unexpected: true }],
          },
        },
      },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('normalizes omitted runtime phases and preserves an independently valid policy mode', () => {
    const config = {
      ...localPreset().agentConfig!,
      runtimePolicy: {
        version: 1 as const,
        authority: 'loom' as const,
        scope: 'preset' as const,
        defaultMode: 'response' as const,
        loomPolicy: runtimeLoomPolicy() as unknown as NonNullable<AgentConfigV2['runtimePolicy']>['loomPolicy'],
        phases: [],
      },
      taskPolicy: { templateIds: ['write'] },
    } satisfies AgentConfigV2
    const portable = toPortableAgentConfigV1(config)
    const { phases: _phases, ...runtimePolicyWithoutPhases } = portable.runtimePolicy!
    const parsed = parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: {
        ...portable,
        runtimePolicy: runtimePolicyWithoutPhases as typeof portable.runtimePolicy,
      },
    })

    expect(parsed.agentConfig?.runtimePolicy).toEqual({
      ...runtimePolicyWithoutPhases,
      phases: [],
    })
    expect(parsed.agentConfig?.runtimePolicy?.defaultMode).toBe('response')
    expect(parsed.agentConfig?.defaultMode).toBe('agentic')
  })
  test('accepts an independently valid runtime default mode when config default differs', () => {
    const candidate = envelope()
    const policy = parseAgentRuntimePolicyV1(runtimePolicy({ defaultMode: 'agentic' }))
    candidate.agentConfig = {
      ...portableConfig(),
      defaultMode: 'response',
      runtimePolicy: policy,
    }
    const parsed = parsePortableAgenticRuntimeEnvelope(candidate)

    expect(parsed.agentConfig?.defaultMode).toBe('response')
    expect(parsed.agentConfig?.runtimePolicy?.defaultMode).toBe('agentic')
  })
  test('accepts the backend top-level runtimePolicy alias and normalizes it into agentConfig', () => {
    const policy = parseAgentRuntimePolicyV1(runtimePolicy())
    const parsed = parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      runtimePolicy: policy,
    })

    expect(parsed).not.toHaveProperty('runtimePolicy')
    expect(parsed.agentConfig?.runtimePolicy).toEqual(policy)
  })

  test('rejects duplicate top-level and nested runtimePolicy aliases', () => {
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        runtimePolicy: runtimePolicy(),
      },
      runtimePolicy: runtimePolicy(),
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })
  test('rejects canonical runtimePolicy alongside legacy cognition in nested and top-level aliases', () => {
    const legacyCognitionPolicy = {
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
    const canonicalConfig: PortableAgentConfigV1 = {
      ...portableConfig(),
      runtimePolicy: parseAgentRuntimePolicyV1(runtimePolicy()),
    }
    const nestedInput: unknown = {
      ...envelope(),
      agentConfig: {
        ...canonicalConfig,
        cognitionPolicy: legacyCognitionPolicy,
      },
    }
    expect(() => parsePortableAgenticRuntimeEnvelope(nestedInput)).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')

    const topLevelInput: unknown = {
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        cognitionPolicy: legacyCognitionPolicy,
      },
      runtimePolicy: parseAgentRuntimePolicyV1(runtimePolicy()),
    }
    expect(() => parsePortableAgenticRuntimeEnvelope(topLevelInput)).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })
  test('preserves bounded legacy cognition only as inert repair data and accepts explicit empty graph policies', () => {
    const legacy = {
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        cognitionPolicy: { repair: { source: 'foreign', values: ['retain'] } },
      },
    }
    expect(parsePortableAgenticRuntimeEnvelope(legacy).agentConfig?.cognitionPolicy).toEqual(
      legacy.agentConfig.cognitionPolicy,
    )
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...legacy,
      agentConfig: {
        ...legacy.agentConfig,
        cognitionPolicy: { repair: 'x'.repeat(AGENTIC_PREDICATE_MAX_LIST_BYTES + 1) },
      },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')

    const explicitEmptyPolicies = parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        taskPolicy: { templateIds: [] },
      },
      taskTemplates: [],
    })
    expect(explicitEmptyPolicies.agentConfig?.taskPolicy).toEqual({ templateIds: [] })
  })
  test('rejects hostile dense arrays before authority traversal expands them', () => {
    const hostile = new Array(1_000_000_000)
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: {
        ...portableConfig(),
        cognitionPolicy: { hostile },
      },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })



  test('rejects graph dependency cycles and missing task policy references', () => {
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      agentConfig: { ...portableConfig(), taskPolicy: { templateIds: ['missing'] } },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...envelope(),
      taskTemplates: [
        { id: 'a', required: false, dependencies: ['b'] },
        { id: 'b', required: false, dependencies: ['a'] },
      ],
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })


  test('enforces backend predicate node, list, byte, and scalar safety budgets', () => {
    const policyFor = (condition: Record<string, unknown>) => runtimePolicy({
      loomPolicy: runtimeLoomPolicy({
        workPolicy: [runtimePolicyEntry('conditional', runtimeSource('conditional-source'), {
          condition,
        })],
      }),
    })
    const phaseLeaf = () => ({ kind: 'phase', value: 'WORK' })
    const atNodeLimit = {
      kind: 'all',
      children: Array.from({ length: AGENTIC_PREDICATE_MAX_NODES - 1 }, phaseLeaf),
    }
    const overNodeLimit = {
      kind: 'all',
      children: Array.from({ length: AGENTIC_PREDICATE_MAX_NODES }, phaseLeaf),
    }
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor(atNodeLimit),
    ))).not.toThrow()
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor(overNodeLimit),
    ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')

    const atItemLimit = Array.from(
      { length: AGENTIC_PREDICATE_MAX_LIST_ITEMS },
      (_, index) => `tag-${index}`,
    )
    const overItemLimit = [...atItemLimit, 'tag-over-limit']
    const inPredicate = (values: unknown[]) => ({
      kind: 'participant_fact',
      name: 'tags',
      operator: 'in',
      values,
    })
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor(inPredicate(atItemLimit)),
    ))).not.toThrow()
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor(inPredicate(overItemLimit)),
    ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')

    const byteLimitValues = Array.from(
      { length: AGENTIC_PREDICATE_MAX_LIST_BYTES / AGENTIC_PREDICATE_MAX_STRING_BYTES },
      () => 'x'.repeat(AGENTIC_PREDICATE_MAX_STRING_BYTES),
    )
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor({
        kind: 'participant_fact',
        name: 'tags',
        operator: 'equals',
        value: byteLimitValues,
      }),
    ))).not.toThrow()
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor({
        kind: 'participant_fact',
        name: 'tags',
        operator: 'equals',
        value: [...byteLimitValues, 'x'],
      }),
    ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')

    for (const unsafeValue of ['{{agent::unsafe}}', 'x'.repeat(AGENTIC_PREDICATE_MAX_STRING_BYTES + 1)]) {
      expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
        policyFor({
          kind: 'participant_fact',
          name: 'tags',
          operator: 'equals',
          value: unsafeValue,
        }),
      ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    }
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      policyFor(inPredicate(['duplicate', 'duplicate'])),
    ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('enforces the backend custom-phase instruction block ID character bound', () => {
    for (const blockId of ['a'.repeat(128), '😀'.repeat(128)]) {
      const accepted = runtimePolicy({
        phases: [runtimePhase('bounded_phase', {
          instructionRefs: [runtimeSource(blockId)],
        })],
      })
      expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(accepted))).not.toThrow()
    }

    for (const blockId of ['a'.repeat(129), '😀'.repeat(129)]) {
      const rejected = runtimePolicy({
        phases: [runtimePhase('bounded_phase', {
          instructionRefs: [runtimeSource(blockId)],
        })],
      })
      expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(rejected)))
        .toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    }

    const canonicalLoomSourceAtLimit = runtimePolicy({
      loomPolicy: runtimeLoomPolicy({
        workPolicy: [runtimePolicyEntry(
          'canonical-source',
          runtimeSource('b'.repeat(256)),
        )],
      }),
    })
    expect(() => parsePortableAgenticRuntimeEnvelope(
      envelopeWithRuntimePolicy(canonicalLoomSourceAtLimit),
    )).not.toThrow()
  })


  test('enforces the aggregate source block bound across Loom policy and custom phases', () => {
    const phases = (includeExtraSource: boolean) => Array.from({ length: 64 }, (_, phaseIndex) =>
      runtimePhase(`phase_${phaseIndex}`, {
        instructionRefs: Array.from(
          { length: includeExtraSource && phaseIndex === 0 ? 9 : 8 },
          (_, refIndex) => runtimeSource(
            phaseIndex === 0 && refIndex === 0
              ? 'shared-source'
              : `phase-${phaseIndex}-${refIndex}`,
            refIndex,
          ),
        ),
      }))
    const loomPolicy = runtimeLoomPolicy({
      workPolicy: [runtimePolicyEntry('policy-source', runtimeSource('shared-source'))],
    })
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      runtimePolicy({ loomPolicy, phases: phases(false) }),
    ))).not.toThrow()
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(
      runtimePolicy({ loomPolicy, phases: phases(true) }),
    ))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('rejects unknown and non-adjacent custom phase transitions', () => {
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
      phases: [
        runtimePhase('one', { nextPhaseIds: ['three'] }),
        runtimePhase('two'),
        runtimePhase('three'),
      ],
    })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
      phases: [runtimePhase('one', { nextPhaseIds: ['missing'] })],
    })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })
  test('distinguishes custom phase instruction refs by exact block occurrence', () => {
    const occurrences = [
      runtimeSource('same-source', 0, 1),
      runtimeSource('same-source', 1, 2),
    ]
    const parsed = parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
      phases: [runtimePhase('occurrences', { instructionRefs: occurrences })],
    })))
    expect(parsed.agentConfig?.runtimePolicy?.phases[0]?.instructionRefs).toEqual([
      { kind: 'loom_block', blockId: 'same-source', presetRevision: 0, blockRevision: 1, promptOrder: 0 },
      { kind: 'loom_block', blockId: 'same-source', presetRevision: 0, blockRevision: 2, promptOrder: 1 },
    ] as const)

    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
      phases: [runtimePhase('duplicate', {
        instructionRefs: [
          runtimeSource('same-source', 0, 1),
          runtimeSource('same-source', 0, 2),
        ],
      })],
    })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('accepts backend-valid custom phase labels by Unicode character count and preserves raw labels', () => {
    for (const label of ['', '😀'.repeat(80), 'a'.repeat(80)]) {
      const policy = runtimePolicy({
        phases: [runtimePhase('labelled', { label })],
      })
      const parsed = parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(policy))
      expect(parsed.agentConfig?.runtimePolicy).toEqual(policy as unknown as NonNullable<AgentConfigV2['runtimePolicy']>)
    }
    for (const label of ['a'.repeat(81), '😀'.repeat(81)]) {
      expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
        phases: [runtimePhase('labelled', { label })],
      })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    }
  })

  test('accepts canonical empty all and any cognition predicates without substitution', () => {
    const policy = runtimePolicy({
      loomPolicy: runtimeLoomPolicy({
        workPolicy: [runtimePolicyEntry('conditional', runtimeSource('conditional-source'), {
          condition: { kind: 'all', children: [] },
        })],
      }),
      phases: [runtimePhase('empty_predicates', {
        enter: { kind: 'all', children: [] },
        exit: { kind: 'any', children: [] },
      })],
    })
    const parsed = parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(policy))
    expect(parsed.agentConfig?.runtimePolicy).toEqual(policy as unknown as NonNullable<AgentConfigV2['runtimePolicy']>)
    expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
      phases: [runtimePhase('invalid_predicate', {
        enter: { kind: 'all', children: [null] },
      })],
    })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('accepts non-negative zero block and preset revisions without substitution', () => {
    const policy = runtimePolicy({
      loomPolicy: runtimeLoomPolicy({
        workPolicy: [runtimePolicyEntry('zero-policy', runtimeSource('zero-policy-source', 0, 0))],
      }),
      phases: [runtimePhase('zero_phase', {
        instructionRefs: [runtimeSource('zero-phase-source', 0, 0)],
      })],
    })
    const parsed = parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(policy))
    expect(parsed.agentConfig?.runtimePolicy).toEqual(policy as unknown as NonNullable<AgentConfigV2['runtimePolicy']>)
    for (const source of [
      runtimeSource('invalid-preset-revision', 0, 1),
      runtimeSource('invalid-block-revision', 0, 1),
    ]) {
      const invalidSource = { ...source, ...(source.blockId === 'invalid-preset-revision'
        ? { presetRevision: -1 }
        : { blockRevision: -1 }) }
      expect(() => parsePortableAgenticRuntimeEnvelope(envelopeWithRuntimePolicy(runtimePolicy({
        phases: [runtimePhase('invalid_revision', { instructionRefs: [invalidSource] })],
      })))).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    }
  })


  test('fails closed when the envelope is malformed or contains a local binding', () => {
    const valid = envelope()
    expect(() => parsePortableAgenticRuntimeEnvelope({ ...valid, version: 2 })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    const staleChildCapability = envelope()
    ;(staleChildCapability.agentConfig!.profiles[0] as unknown as { workspaceCapabilities: unknown }).workspaceCapabilities = ['record_question']
    expect(() => parsePortableAgenticRuntimeEnvelope(staleChildCapability)).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => parsePortableAgenticRuntimeEnvelope({
      ...valid,
      agentConfig: {
        ...valid.agentConfig,
        profiles: [{
          ...valid.agentConfig!.profiles[0],
          connectionProfileId: 'local-profile-id',
        },
        ],
      },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
    expect(() => extractPortableAgenticRuntimeEnvelope({
      ...localPreset(),
      agentRuntime: { ...valid, taskTemplates: [{ id: 'invalid', required: 'yes' }] },
    })).toThrow('AGENT_RUNTIME_PORTABLE_INVALID')
  })

  test('keeps a no-envelope internal import on the Response-compatible path', () => {
    const responseOnly = { ...localPreset(), passthroughMetadata: { extension: { preserve: true } } }
    delete (responseOnly as unknown as Record<string, unknown>).agentConfig
    delete (responseOnly as unknown as Record<string, unknown>).agentSlotBindings
    delete (responseOnly as unknown as Record<string, unknown>).agentConfigReview
    const imported = coerceImportedLoomPreset(responseOnly, 'Fallback')
    const request = marshalPreset(imported)
    expect(extractPortableAgenticRuntimeEnvelope(responseOnly)).toBeNull()
    expect(request.metadata).not.toHaveProperty('agentConfig')
    expect(request.metadata).not.toHaveProperty('agentConfigReviewRequired')
  })
  test('does not resurrect legacy metadata when a canonical portable envelope is present', () => {
    const payload = createPortableLoomExportPayload(localPreset(), envelope())
    payload.passthroughMetadata = {
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 1,
        maxToolCalls: 1,
        mainToolIds: [],
        mainLoreScope: 'active',
        profiles: [],
      },
      extension: { preserve: true },
    }

    const imported = coerceImportedLoomPreset(payload, 'Fallback')
    expect(imported.agentConfig).toBeNull()
    const metadata = marshalPreset(imported).metadata!
    expect(metadata.agentConfig).toBeUndefined()
    expect(metadata.extension).toEqual({ preserve: true })
  })
  test('keeps canonical top-level V2 config over obsolete metadata.agentConfig', () => {
    const canonicalConfig = localPreset().agentConfig!
    const imported = coerceImportedLoomPreset({
      ...localPreset(),
      agentConfig: canonicalConfig,
      passthroughMetadata: {
        agentConfig: {
          version: 1,
          enabled: false,
          maxInvocations: 1,
          maxToolCalls: 1,
          mainToolIds: [],
          mainLoreScope: 'active',
          profiles: [],
        },
        extension: { preserve: true },
      },
    }, 'Fallback')

    expect(imported.agentConfig).toEqual(canonicalConfig)
    expect(imported.passthroughMetadata).toEqual({ extension: { preserve: true } })
  })
})
