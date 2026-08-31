import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { effectiveRuntimeApi } from '@/api/effective-runtime'
import type {
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
  LoomRuntimePolicyV1,
} from '@/types/effective-runtime'
import { isAgenticGenerationType, repairCategoryForCode } from '@/types/effective-runtime'
import * as runtime from './agentRuntimeSelection'
import type { RuntimeGenerationRequest } from './agentRuntimeSelection'

let resolveRuntime: (request: EffectiveRuntimeRequestV1) => Promise<EffectiveRuntimePublicResponseV1>
const resolveCalls: EffectiveRuntimeRequestV1[] = []

const resolveSpy = spyOn(effectiveRuntimeApi, 'resolve')
resolveSpy.mockImplementation((request) => {
  resolveCalls.push(request)
  return resolveRuntime(request)
})
const runtimePolicy: LoomRuntimePolicyV1 = {
  version: 1,
  authoredValue: 'agentic',
  effectiveValue: 'agentic',
  source: 'reviewed_preset_default',
  scope: 'preset',
  cap: { authority: 'host', allowedModes: ['response', 'agentic'], reasonCode: null },
  availability: { state: 'available', reasonCode: null },
  presetRevision: 1,
  transientSelection: null,
  durableChatOverride: null,
  repairAcknowledgement: {
    state: 'not_required',
    presetRevision: 1,
    reasonCode: null,
    acknowledgedAt: null,
  },
  nextTurnOnly: true,
}


function decision(
  request: EffectiveRuntimeRequestV1,
  overrides: Partial<EffectiveRuntimePublicResponseV1> = {},
): EffectiveRuntimePublicResponseV1 {
  const requestedMode = overrides.requestedMode ?? runtimePolicy.authoredValue
  const effectiveMode = overrides.effectiveMode ?? runtimePolicy.effectiveValue
  const responsePolicy = overrides.runtimePolicy ?? {
    ...runtimePolicy,
    authoredValue: requestedMode,
    effectiveValue: effectiveMode,
  }
  const runtimeDecisionToken = overrides.runtimeDecisionToken === undefined
    ? 'one-use-token'
    : overrides.runtimeDecisionToken
  const runtimeDecisionExpiresAt = overrides.runtimeDecisionExpiresAt === undefined
    ? (runtimeDecisionToken === null ? null : Date.now() + 60_000)
    : overrides.runtimeDecisionExpiresAt
  const responseInspectionOmission: NonNullable<EffectiveRuntimePublicResponseV1['responseOmission']> = {
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds: [],
    source: [],
    omittedPhaseInstructions: [],
  }
  const responseOmission = effectiveMode === 'response' ? responseInspectionOmission : null
  const inspection: EffectiveRuntimePublicResponseV1['inspection'] = effectiveMode === 'response'
    ? {
        version: 1,
        surface: 'RESPONSE',
        checkpoint: 'ASSEMBLE',
        items: [],
        effectiveEntryIds: [],
        responseOmission: responseInspectionOmission,
      }
    : {
        version: 1,
        surface: 'WORK',
        checkpoint: 'ASSEMBLE',
        items: [],
        effectiveEntryIds: [],
      }
  return {
    version: 1,
    chatId: request.chatId,
    target: request.target ?? {
      generationType: isAgenticGenerationType(request.generationType) ? request.generationType : 'normal',
    },
    connection: {
      id: 'connection-1',
      label: 'Primary',
      provider: 'provider',
      model: 'model',
      revision: 1,
      endpointRevision: 1,
      credentialRevision: 1,
      candidateRevision: 1,
    },
    inspection,
    responseOmission,
    preset: { id: 'preset-1', label: 'Preset', revision: 1, source: 'chat' },
    agentsEnabled: true,
    allowedModes: ['response', 'agentic'],
    defaultMode: 'response',
    requestedMode,
    effectiveMode,
    runtimePolicy: responsePolicy,
    chatOverride: null,
    capabilityReadiness: {
      ready: true,
      sameDomain: true,
      required: ['generation', 'streaming', 'tool_calling', 'tools_disabled_finalization'],
      missing: [],
      repairCodes: [],
      responseEscape: 'available',
    },
    repairCodes: [],
    runtimeDecisionToken,
    runtimeDecisionExpiresAt,
    ...overrides,
  }
}

afterAll(() => {
  resolveSpy.mockRestore()
})

beforeEach(() => {
  runtime.resetAgentRuntimeSelectionForTests()
  resolveCalls.length = 0
  resolveRuntime = async (request) => decision(request)
})

describe('agent runtime generation preparation', () => {
  test('preserves the Response path when no one-turn or durable Agentic mode is selected', async () => {
    const request = { chat_id: 'chat-1', generation_type: 'normal' as const }
    const prepared = await runtime.prepareAgentRuntimeRequest(request)

    expect(prepared.request).toBe(request)
    expect(resolveCalls).toHaveLength(0)
  })
  test('does not publish a foreign response into the accepted runtime selection', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')
    resolveRuntime = async (request) => ({
      ...decision(request),
      chatId: 'chat-foreign',
    })

    await expect(runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })).rejects.toMatchObject({ code: 'malformed_response' })

    const snapshot = runtime.getRuntimeSelectionSnapshot('chat-1')
    expect(snapshot.decision).toBeNull()
    expect(snapshot.effectiveMode).toBeNull()
    expect(snapshot.activeGenerationMode).toBeNull()
    expect(snapshot.oneTurnMode).toBe('agentic')
  })

  test('uses the unexpired display preflight token once for a durable Agentic decision', async () => {
    const request: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }
    runtime.nextRuntimeRequestEpoch('chat-1')
    runtime.publishRuntimeDecision(decision(request), 1)

    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })

    expect(prepared.request.request_epoch).toBe(1)
    expect(prepared.request.runtime_decision_token).toBe('one-use-token')
    expect(resolveCalls).toHaveLength(0)

    const next = runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    expect(resolveCalls).toHaveLength(1)
    await next
  })

  test('uses one decision token for every supported target mode and clears only after dispatch commits', async () => {
    for (const generationType of ['normal', 'continue', 'regenerate', 'swipe'] as const) {
      runtime.resetAgentRuntimeSelectionForTests()
      runtime.setOneTurnRuntimeMode('chat-1', 'agentic')
      const targetFields = generationType === 'normal'
        ? {}
        : {
            message_id: 'message-1',
            ...(generationType === 'swipe' ? { swipe_id: 2 } : {}),
          }
      const prepared = await runtime.prepareAgentRuntimeRequest({
        chat_id: 'chat-1',
        generation_type: generationType,
        target_character_id: 'character-1',
        ...targetFields,
      })
      expect(prepared.request.mode).toBe('agentic')
      expect(prepared.request.runtime_decision_token).toBe('one-use-token')
      expect(prepared.request.message_id).toBe(generationType === 'normal' ? undefined : 'message-1')
      expect(prepared.request.swipe_id).toBe(generationType === 'swipe' ? 2 : undefined)
      expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('agentic')
      expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBe('agentic')

      prepared.commitOneTurnSelection()
      expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBeNull()
      expect(runtime.getRuntimeSelectionSnapshot('chat-1').effectiveMode).toBeNull()
      expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBe('agentic')
    }
  })
  test('binds fresh and cached Agentic swipe decisions to the requested swipe index', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')
    const request = {
      chat_id: 'chat-1',
      generation_type: 'swipe' as const,
      message_id: 'message-1',
      swipe_id: 2,
    }

    const fresh = await runtime.prepareAgentRuntimeRequest(request)

    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0].target?.swipeId).toBe(2)
    expect(fresh.request).toMatchObject({
      generation_type: 'swipe',
      swipe_id: 2,
      mode: 'agentic',
      runtime_decision_token: 'one-use-token',
    })
    expect(fresh.request.request_epoch).toBe(1)

    runtime.resetAgentRuntimeSelectionForTests()
    runtime.nextRuntimeRequestEpoch('chat-1')
    resolveCalls.length = 0
    runtime.publishRuntimeDecision(decision({
      chatId: 'chat-1',
      generationType: 'swipe',
      target: {
        generationType: 'swipe',
        messageId: 'message-1',
        swipeId: 2,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }), 1)

    const cached = await runtime.prepareAgentRuntimeRequest(request)

    expect(resolveCalls).toHaveLength(0)
    expect(cached.request).toMatchObject({
      generation_type: 'swipe',
      swipe_id: 2,
      mode: 'agentic',
      runtime_decision_token: 'one-use-token',
    })
    expect(cached.request.request_epoch).toBe(1)
  })

  test('normalizes delete-style Agentic regeneration on both token paths', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')
    const request: RuntimeGenerationRequest = {
      chat_id: 'chat-1',
      generation_type: 'regenerate',
    }

    const fresh = await runtime.prepareAgentRuntimeRequest(request)

    expect(resolveCalls[0].target).toMatchObject({
      generationType: 'normal',
      messageId: null,
      swipeId: null,
    })
    expect(fresh.request.request_epoch).toBe(1)
    expect(fresh.request.generation_type).toBe('normal')
    expect(fresh.request.runtime_decision_token).toBe('one-use-token')

    runtime.resetAgentRuntimeSelectionForTests()
    runtime.nextRuntimeRequestEpoch('chat-1')
    resolveCalls.length = 0
    runtime.publishRuntimeDecision(decision({
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }), 1)

    const cached = await runtime.prepareAgentRuntimeRequest(request)

    expect(cached.request.request_epoch).toBe(1)
    expect(resolveCalls).toHaveLength(0)
    expect(cached.request.generation_type).toBe('normal')
    expect(cached.request.runtime_decision_token).toBe('one-use-token')
  })

  test('keeps delete-style regeneration unchanged on explicit and effective Response paths', async () => {
    const request = {
      chat_id: 'chat-1',
      generation_type: 'regenerate' as const,
    }
    runtime.setOneTurnRuntimeMode('chat-1', 'response')

    const explicit = await runtime.prepareAgentRuntimeRequest(request)

    expect(explicit.request.generation_type).toBe('regenerate')
    expect(explicit.request.mode).toBe('response')
    expect(resolveCalls).toHaveLength(0)

    runtime.resetAgentRuntimeSelectionForTests()
    runtime.nextRuntimeRequestEpoch('chat-1')
    runtime.publishRuntimeDecision(decision({
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }, {
      effectiveMode: 'response',
      runtimeDecisionToken: null,
    }), 1)

    const effective = await runtime.prepareAgentRuntimeRequest(request)

    expect(effective.request).toBe(request)
    expect(effective.request.generation_type).toBe('regenerate')
    expect(effective.request.mode).toBeUndefined()
    expect(resolveCalls).toHaveLength(0)
  })

  test('clears stale Agentic token and request epoch on Response escape', async () => {
    const request: RuntimeGenerationRequest = {
      chat_id: 'chat-1',
      generation_type: 'normal',
      mode: 'agentic',
      runtime_decision_token: 'stale-token',
      request_epoch: 9,
    }
    const authorityRequest: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }
    runtime.nextRuntimeRequestEpoch('chat-1')
    const durable = decision(authorityRequest, { effectiveMode: 'agentic' })
    runtime.publishRuntimeDecision(durable, 1)
    runtime.setOneTurnRuntimeMode('chat-1', 'response')
    const prepared = await runtime.prepareAgentRuntimeRequest(request)

    expect(prepared.request.mode).toBe('response')
    expect(prepared.request.runtime_decision_token).toBeUndefined()
    expect(prepared.request.request_epoch).toBeUndefined()

    prepared.commitOneTurnSelection()
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').effectiveMode).toBe('agentic')
    const next = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    expect(next.request.mode).toBe('agentic')
    expect(next.request.runtime_decision_token).toBe('one-use-token')
    expect(next.request.request_epoch).toBe(2)
  })

  test('rejects a fresh decision with a mismatched swipe identity', async () => {
    resolveRuntime = async (request) => decision(request, {
      target: {
        generationType: 'swipe',
        messageId: 'message-1',
        swipeId: 1,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
    })
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    await expect(runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'swipe',
      message_id: 'message-1',
      swipe_id: 2,
    })).rejects.toMatchObject({ code: 'malformed_response' })

    expect(resolveCalls[0].target?.swipeId).toBe(2)
  })

  test('rejects unsupported generation surfaces while preserving explicit Agentic selection', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    await expect(runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'impersonate',
    })).rejects.toMatchObject({ code: 'agentic_unsupported_surface' })

    expect(resolveCalls).toHaveLength(0)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('agentic')
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBeNull()

    const escaped = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'impersonate',
      mode: 'response',
      runtime_decision_token: 'stale-token',
    })
    expect(escaped.request.mode).toBe('response')
    expect(escaped.request.runtime_decision_token).toBeUndefined()
    escaped.commitOneTurnSelection()
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBeNull()
  })

  test('forces unsupported surfaces through Response without consuming selection', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'impersonate',
      mode: 'agentic',
      runtime_decision_token: 'stale-token',
    }, { forceResponse: true })

    expect(prepared.request).toMatchObject({
      generation_type: 'impersonate',
      mode: 'response',
    })
    expect(prepared.request.runtime_decision_token).toBeUndefined()
    prepared.commitOneTurnSelection()
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('agentic')
  })

  test('rejects an older request epoch after a newer preflight starts', async () => {
    const deferred: Array<{
      promise: Promise<EffectiveRuntimePublicResponseV1>
      resolve(value: EffectiveRuntimePublicResponseV1): void
      reject(reason?: unknown): void
    }> = []
    resolveRuntime = () => {
      const pending = Promise.withResolvers<EffectiveRuntimePublicResponseV1>()
      deferred.push(pending)
      return pending.promise
    }
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    const first = runtime.prepareAgentRuntimeRequest({ chat_id: 'chat-1', generation_type: 'normal' })
    const second = runtime.prepareAgentRuntimeRequest({ chat_id: 'chat-1', generation_type: 'normal' })
    deferred[0].resolve(decision(resolveCalls[0]))

    await expect(first).rejects.toMatchObject({ code: 'decision_refresh_required' })
    deferred[1].resolve(decision(resolveCalls[1]))
    await second
  })
  test('passive display refresh does not supersede a fresh Send preflight', async () => {
    const deferred: Array<{
      promise: Promise<EffectiveRuntimePublicResponseV1>
      resolve(value: EffectiveRuntimePublicResponseV1): void
    }> = []
    resolveRuntime = () => {
      const pending = Promise.withResolvers<EffectiveRuntimePublicResponseV1>()
      deferred.push(pending)
      return pending.promise
    }
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    const send = runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    }, { forceRuntimeRefresh: true })
    expect(resolveCalls[0]?.requestEpoch).toBe(1)

    const displayEpoch = runtime.nextRuntimeDisplayEpoch('chat-1')
    const displayRequest = { ...resolveCalls[0], requestEpoch: displayEpoch }
    const display = effectiveRuntimeApi.resolve(displayRequest)
    expect(resolveCalls[1]?.requestEpoch).toBe(displayEpoch)

    deferred[0].resolve(decision(resolveCalls[0]))
    await send

    deferred[1].resolve(decision(displayRequest))
    await display
  })

  test('rejects a slow preflight when the user switches to Response', async () => {
    const deferred: Array<{
      promise: Promise<EffectiveRuntimePublicResponseV1>
      resolve(value: EffectiveRuntimePublicResponseV1): void
    }> = []
    resolveRuntime = () => {
      const pending = Promise.withResolvers<EffectiveRuntimePublicResponseV1>()
      deferred.push(pending)
      return pending.promise
    }
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    const pending = runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    runtime.setOneTurnRuntimeMode('chat-1', 'response')
    deferred[0].resolve(decision(resolveCalls[0]))

    await expect(pending).rejects.toMatchObject({ code: 'decision_refresh_required' })
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('response')
  })

  test('rejects chat and target mismatches without silently changing the selected mode', async () => {
    resolveRuntime = async (request) => decision(request, { chatId: 'different-chat' })
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    await expect(runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'swipe',
      message_id: 'message-1',
    })).rejects.toMatchObject({ code: 'malformed_response' })
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('agentic')
  })

  test('does not downgrade an explicit Agentic selection when readiness fails', async () => {
    resolveRuntime = async (request) => decision(request, {
      effectiveMode: 'response',
      runtimeDecisionToken: null,
      repairCodes: ['agentic_slot_unresolved'],
      capabilityReadiness: {
        ready: false,
        sameDomain: true,
        required: ['generation'],
        missing: [],
        repairCodes: ['agentic_slot_unresolved'],
        responseEscape: 'available',
      },
    })
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    await expect(runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })).rejects.toMatchObject({ code: 'agentic_unavailable' })
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').oneTurnMode).toBe('agentic')
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').decision).not.toHaveProperty('runtimeDecisionToken')
  })

  for (const [label, changeScope] of [
    ['connection', (request: RuntimeGenerationRequest) => ({ ...request, connection_id: 'connection-2' })],
    ['preset', (request: RuntimeGenerationRequest) => ({ ...request, preset_id: 'preset-2' })],
    ['forced preset', (request: RuntimeGenerationRequest) => ({ ...request, force_preset_id: true })],
    ['persona', (request: RuntimeGenerationRequest) => ({ ...request, persona_id: 'persona-2' })],
  ] as const) {
    test(`does not reuse an activation token after ${label} scope changes`, async () => {
      const request: RuntimeGenerationRequest = {
        chat_id: 'chat-1',
        generation_type: 'normal',
        connection_id: 'connection-1',
        preset_id: 'preset-1',
        force_preset_id: false,
        persona_id: 'persona-1',
        target_character_id: 'character-1',
      }
      const authorityRequest: EffectiveRuntimeRequestV1 = {
        chatId: 'chat-1',
        connectionId: 'connection-1',
        presetId: 'preset-1',
        forcePresetId: false,
        personaId: 'persona-1',
        targetCharacterId: 'character-1',
        generationType: 'normal',
        target: {
          generationType: 'normal',
          messageId: null,
          swipeId: null,
          branchId: null,
          targetCharacterId: 'character-1',
          revision: null,
        },
        requestEpoch: 1,
      }
      runtime.nextRuntimeRequestEpoch('chat-1')
      const projected = decision(authorityRequest)
      runtime.publishRuntimeDecision(projected, 1, runtime.createRuntimeScopeFingerprint({
        chatId: request.chat_id,
        generationType: request.generation_type,
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: request.target_character_id,
        logicalConnectionId: request.connection_id,
        presetId: request.preset_id,
        forcePresetId: request.force_preset_id,
        personaId: request.persona_id,
      }, projected))

      await runtime.prepareAgentRuntimeRequest(request)
      expect(resolveCalls).toHaveLength(0)

      await runtime.prepareAgentRuntimeRequest(changeScope(request))
      expect(resolveCalls).toHaveLength(1)
    })
  }

  test('restores the durable Agentic mode after a one-turn Response escape', async () => {
    const request: RuntimeGenerationRequest = {
      chat_id: 'chat-1',
      generation_type: 'normal',
      connection_id: 'connection-1',
      preset_id: 'preset-1',
      force_preset_id: false,
      persona_id: 'persona-1',
      target_character_id: 'character-1',
    }
    const authorityRequest: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      connectionId: 'connection-1',
      presetId: 'preset-1',
      forcePresetId: false,
      personaId: 'persona-1',
      targetCharacterId: 'character-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: 'character-1',
        revision: null,
      },
      requestEpoch: 1,
    }
    runtime.nextRuntimeRequestEpoch('chat-1')
    const projected = decision(authorityRequest, { effectiveMode: 'agentic' })
    runtime.publishRuntimeDecision(projected, 1, runtime.createRuntimeScopeFingerprint({
      chatId: request.chat_id,
      generationType: request.generation_type,
      messageId: null,
      swipeId: null,
      branchId: null,
      targetCharacterId: request.target_character_id,
      logicalConnectionId: request.connection_id,
      presetId: request.preset_id,
      forcePresetId: request.force_preset_id,
      personaId: request.persona_id,
    }, projected))

    const durable = await runtime.prepareAgentRuntimeRequest(request)
    durable.commitOneTurnSelection()
    runtime.setOneTurnRuntimeMode('chat-1', 'response')
    const escaped = await runtime.prepareAgentRuntimeRequest(request)
    expect(escaped.request.mode).toBe('response')
    escaped.commitOneTurnSelection()

    expect(runtime.getRuntimeSelectionSnapshot('chat-1').effectiveMode).toBe('agentic')
    const next = await runtime.prepareAgentRuntimeRequest(request)
    expect(resolveCalls).toHaveLength(1)
    expect(next.request.mode).toBe('agentic')
  })

  test('forces a fresh decision after a chat-affecting write invalidates the display token', async () => {
    const authorityRequest: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }
    runtime.nextRuntimeRequestEpoch('chat-1')
    const projected = decision(authorityRequest)
    runtime.publishRuntimeDecision(projected, 1)

    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    }, { forceRuntimeRefresh: true })

    expect(resolveCalls).toHaveLength(1)
    expect(prepared.request.request_epoch).toBe(2)
    expect(prepared.request.runtime_decision_token).toBe('one-use-token')
  })

  test('a committed preset authority mutation fences the cached send token and resolves fresh', async () => {
    const authorityRequest: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      generationType: 'normal',
      target: {
        generationType: 'normal',
        messageId: null,
        swipeId: null,
        branchId: null,
        targetCharacterId: null,
        revision: null,
      },
      requestEpoch: 1,
    }
    runtime.nextRuntimeRequestEpoch('chat-1')
    runtime.publishRuntimeDecision(decision(authorityRequest), 1)
    let notifications = 0
    const unsubscribe = runtime.subscribeRuntimeAuthority(() => { notifications += 1 })

    runtime.commitRuntimeAuthorityMutation()
    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    unsubscribe()

    expect(runtime.getRuntimeAuthorityRevision()).toBe(1)
    expect(notifications).toBe(1)
    expect(resolveCalls).toHaveLength(1)
    expect(prepared.request.request_epoch).toBe(2)
    expect(prepared.request.runtime_decision_token).toBe('one-use-token')
  })

  test('fences a deferred Agentic preflight on authority commit without consuming the selection', async () => {
    const pending = Promise.withResolvers<EffectiveRuntimePublicResponseV1>()
    resolveRuntime = () => pending.promise
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')

    const oldPrepare = runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    runtime.commitRuntimeAuthorityMutation()
    pending.resolve(decision(resolveCalls[0]))

    await expect(oldPrepare).rejects.toMatchObject({ code: 'decision_refresh_required' })
    expect(runtime.getRuntimeSelectionSnapshot('chat-1')).toMatchObject({
      decision: null,
      effectiveMode: null,
      activeGenerationMode: null,
      oneTurnMode: 'agentic',
    })

    resolveRuntime = async (request) => decision(request)
    const fresh = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    expect(fresh.request.mode).toBe('agentic')
  })

  test('preserves an admitted Agentic run and its request epoch across authority commit', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'agentic')
    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'normal',
    })
    const requestEpoch = prepared.request.request_epoch!
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBe('agentic')

    runtime.commitRuntimeAuthorityMutation()

    expect(runtime.getRuntimeAuthorityRevision()).toBe(1)
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBe('agentic')
    expect(runtime.isCurrentRuntimeRequest('chat-1', requestEpoch)).toBe(true)
    runtime.resetActiveGenerationMode('chat-1')
    expect(runtime.getRuntimeSelectionSnapshot('chat-1').activeGenerationMode).toBeNull()
  })
  test('keeps explicit Response swipe generation on the legacy request path', async () => {
    runtime.setOneTurnRuntimeMode('chat-1', 'response')
    const prepared = await runtime.prepareAgentRuntimeRequest({
      chat_id: 'chat-1',
      generation_type: 'swipe',
      message_id: 'message-1',
      swipe_id: 2,
    })

    expect(resolveCalls).toHaveLength(0)
    expect(prepared.request).toMatchObject({
      generation_type: 'swipe',
      mode: 'response',
    })
    expect(prepared.request.runtime_decision_token).toBeUndefined()
  })

  test('localizes known backend runtime and readiness codes', () => {
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'AGENTIC_PROVIDER_FAILURE' } }))
      .toBe('agentRuntime.errors.agentic_provider_failure')
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'AGENTIC_SLOT_UNRESOLVED' } }))
      .toBe('agentRuntime.repair.slot')
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'DECISION_REFRESH_REQUIRED' } }))
      .toBe('agentRuntime.errors.decision_refresh_required')
    expect(runtime.agentRuntimeErrorTranslationKey(
      new runtime.AgentRuntimePreflightError('agentic_unsupported_surface', ['agentic_generation_type_unsupported']),
    )).toBe('agentRuntime.errors.agentic_unsupported_surface')
  })

  test('covers shared generation-path runtime, preflight, and unknown mappings', () => {
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'AGENTIC_PROVIDER_FAILURE' } }))
      .toBe('agentRuntime.errors.agentic_provider_failure')
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'AGENTIC_SLOT_UNRESOLVED' } }))
      .toBe('agentRuntime.repair.slot')
    const preflight = new runtime.AgentRuntimePreflightError('agentic_unavailable', [])
    expect(runtime.agentRuntimeErrorTranslationKey(preflight))
      .toBe('agentRuntime.preflight.unavailable')
    expect(runtime.agentRuntimePreflightTranslationKey(preflight))
      .toBe('agentRuntime.preflight.unavailable')
    expect(runtime.agentRuntimeErrorTranslationKey({ body: { code: 'NEW_RUNTIME_FAILURE' }, message: 'raw provider text' }))
      .toBeNull()
  })

  test('maps stable readiness failures to actionable repair categories', () => {
    expect(repairCategoryForCode('agentic_slot_unresolved')).toBe('slot')
    expect(repairCategoryForCode('agentic_capability_missing_tool_calling')).toBe('provider')
    expect(repairCategoryForCode('agentic_readiness_unavailable')).toBe('isolate')
    expect(repairCategoryForCode('agentic_domain_mismatch')).toBe('egress')
    expect(repairCategoryForCode('agentic_input_revisions_incomplete')).toBe('readiness')
  })
})
