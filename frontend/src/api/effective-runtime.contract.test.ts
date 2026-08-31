import { afterEach, describe, expect, mock, test } from 'bun:test'
import { effectiveRuntimeApi, EFFECTIVE_RUNTIME_LIMITS, EffectiveRuntimeProtocolError, normalizeEffectiveRuntimeResponse } from './effective-runtime'
import type {
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
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

const fallbackPolicy: LoomRuntimePolicyV1 = {
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

function validResponse(): EffectiveRuntimePublicResponseV1 {
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
    chatId: 'chat-1',
    target: structuredClone(target),
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
    runtimePolicy: structuredClone(fallbackPolicy),
    chatOverride: null,
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

function malformed(change: (body: Record<string, unknown>) => void): unknown {
  const body = structuredClone(validResponse()) as unknown as Record<string, unknown>
  change(body)
  return body
}

async function protocolFailure(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(EffectiveRuntimeProtocolError)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('effective runtime response boundary', () => {
  test('accepts a canonical response with explicit null optional fields unchanged', () => {
    const body = validResponse()
    expect(normalizeEffectiveRuntimeResponse(body, { chatId: 'chat-1', target })).toEqual(body)
  })

  test('rejects missing, null, and malformed targets', async () => {
    for (const body of [
      malformed((value) => { delete value.target }),
      malformed((value) => { value.target = null }),
      malformed((value) => { value.target = [] }),
      malformed((value) => { value.target = { generationType: 'normal', messageId: undefined } }),
    ]) {
      await protocolFailure(Promise.resolve().then(() => normalizeEffectiveRuntimeResponse(body)))
    }
  })

  test('rejects a foreign chat or any foreign target identity', async () => {
    const foreignChat = malformed((value) => { value.chatId = 'chat-foreign' })
    const foreignMessage = malformed((value) => {
      ;(value.target as Record<string, unknown>).messageId = 'message-foreign'
    })
    const foreignPresence = malformed((value) => {
      delete (value.target as Record<string, unknown>).messageId
    })

    for (const body of [foreignChat, foreignMessage, foreignPresence]) {
      await protocolFailure(Promise.resolve().then(() => normalizeEffectiveRuntimeResponse(body, { chatId: 'chat-1', target })))
    }
  })

  test('rejects invalid modes and contradictory readiness', async () => {
    const invalidMode = malformed((value) => { value.effectiveMode = 'work' })
    const invalidEscape = malformed((value) => {
      ;(value.capabilityReadiness as Record<string, unknown>).responseEscape = 'blocked'
    })
    const contradictoryReadiness = malformed((value) => {
      ;(value.capabilityReadiness as Record<string, unknown>).missing = ['generation']
    })

    for (const body of [invalidMode, invalidEscape, contradictoryReadiness]) {
      await protocolFailure(Promise.resolve().then(() => normalizeEffectiveRuntimeResponse(body)))
    }
  })

  test('rejects oversized or wrong-type identifiers before consumers can inspect them', async () => {
    const oversizedChat = malformed((value) => {
      value.chatId = 'x'.repeat(EFFECTIVE_RUNTIME_LIMITS.maxIdBytes + 1)
    })
    const wrongConnectionId = malformed((value) => {
      ;(value.connection as Record<string, unknown>).id = 42
    })
    const oversizedMessageId = malformed((value) => {
      ;(value.target as Record<string, unknown>).messageId = 'x'.repeat(EFFECTIVE_RUNTIME_LIMITS.maxIdBytes + 1)
    })

    for (const body of [oversizedChat, wrongConnectionId, oversizedMessageId]) {
      await protocolFailure(Promise.resolve().then(() => normalizeEffectiveRuntimeResponse(body)))
    }
  })

  test('accepts an explicit host rejection/fallback policy and keeps its provenance', () => {
    const body = validResponse()
    body.allowedModes = ['response']
    body.requestedMode = 'agentic'
    body.runtimePolicy = {
      version: 1,
      authoredValue: 'agentic',
      effectiveValue: 'response',
      source: 'host_rejected',
      scope: 'host',
      cap: { authority: 'host', allowedModes: ['response'], reasonCode: 'loom_policy_unavailable' },
      availability: { state: 'unavailable', reasonCode: 'loom_policy_unavailable' },
      presetRevision: 7,
      transientSelection: { mode: 'agentic', turnFence: 3, authenticated: true },
      durableChatOverride: {
        mode: 'agentic',
        revision: 4,
        state: 'ready',
        reviewCode: null,
        acknowledged: true,
      },
      repairAcknowledgement: {
        state: 'required',
        presetRevision: 7,
        reasonCode: 'foreign_import',
        acknowledgedAt: null,
      },
      nextTurnOnly: true,
    }
    body.capabilityReadiness = {
      ready: false,
      sameDomain: true,
      required: ['generation'],
      missing: ['generation'],
      repairCodes: ['loom_policy_unavailable'],
      responseEscape: 'available',
    }
    body.repairCodes = ['loom_policy_unavailable']

    expect(normalizeEffectiveRuntimeResponse(body).runtimePolicy).toEqual(body.runtimePolicy)
  })

  test('rejects malformed policy version and unsupported provenance enums', async () => {
    const badVersion = malformed((value) => {
      ;(value.runtimePolicy as Record<string, unknown>).version = 2
    })
    const badSource = malformed((value) => {
      ;(value.runtimePolicy as Record<string, unknown>).source = 'untrusted'
    })
    const badAck = malformed((value) => {
      ;(value.runtimePolicy as Record<string, unknown>).repairAcknowledgement = {
        state: 'required',
        presetRevision: null,
        reasonCode: '',
        acknowledgedAt: null,
      }
    })

    for (const body of [badVersion, badSource, badAck]) {
      await protocolFailure(Promise.resolve().then(() => normalizeEffectiveRuntimeResponse(body)))
    }
  })

  test('uses the same strict boundary for POST, PUT, and DELETE responses', async () => {
    const requests: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET')
      const body = init?.method === 'POST'
        ? validResponse()
        : { chatId: 'chat-1', mode: 'agentic', revision: 3, state: 'ready', appliesTo: 'next_turn' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const request: EffectiveRuntimeRequestV1 = {
      chatId: 'chat-1',
      generationType: 'normal',
      target,
    }
    await expect(effectiveRuntimeApi.resolve(request)).resolves.toEqual(validResponse())
    await expect(effectiveRuntimeApi.setChatMode('chat-1', { mode: 'agentic', expectedRevision: 0 })).resolves.toMatchObject({
      chatId: 'chat-1',
      mode: 'agentic',
      revision: 3,
    })
    await expect(effectiveRuntimeApi.resetChatMode('chat-1', 3)).resolves.toMatchObject({
      chatId: 'chat-1',
      mode: 'agentic',
      revision: 3,
    })
    expect(requests).toEqual(['POST', 'PUT', 'DELETE'])
  })

  test('rejects malformed mode-write responses and foreign write identities', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      chatId: 'chat-foreign',
      mode: null,
      revision: 1,
      state: 'ready',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    await protocolFailure(effectiveRuntimeApi.setChatMode('chat-1', { mode: null, expectedRevision: 0 }))
    await protocolFailure(effectiveRuntimeApi.resetChatMode('chat-1', 0))
  })
})
