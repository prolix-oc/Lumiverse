import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { EffectiveRuntimeState } from '@/hooks/useEffectiveRuntime'
import type { LoomRuntimePolicyV1 } from '@/types/effective-runtime'
const selectCalls: string[] = []
const overrideCalls: Array<string | null> = []

const refreshCalls: string[] = []
const responseOmission: NonNullable<EffectiveRuntimeState['responseOmission']> = {
  version: 1,
  surface: 'RESPONSE',
  visibility: 'work_only',
  reason: 'work_only',
  omittedEntryIds: [],
  source: [],
  omittedPhaseInstructions: [],
}
const readyDecision: NonNullable<EffectiveRuntimeState['decision']> = {
  version: 1,
  chatId: 'chat-1',
  target: { generationType: 'normal' },
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
  preset: { id: 'preset-1', label: 'Preset', revision: 1, source: 'chat' },
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
  runtimePolicy: {
    version: 1,
    authoredValue: 'response',
    effectiveValue: 'response',
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
  } satisfies LoomRuntimePolicyV1,
  chatOverride: null,
  capabilityReadiness: {
    ready: true,
    sameDomain: true,
    required: ['generation'],
    missing: [],
    repairCodes: [],
    responseEscape: 'available',
  },
  repairCodes: [],
}

function policyFor(
  changes: Partial<LoomRuntimePolicyV1> = {},
): LoomRuntimePolicyV1 {
  const base = readyDecision.runtimePolicy
  return {
    ...base,
    ...changes,
    cap: { ...base.cap, ...(changes.cap ?? {}) },
    availability: { ...base.availability, ...(changes.availability ?? {}) },
    repairAcknowledgement: {
      ...base.repairAcknowledgement,
      ...(changes.repairAcknowledgement ?? {}),
    },
  }
}

function decisionFor(
  runtimePolicy: LoomRuntimePolicyV1,
  chatOverride = readyDecision.chatOverride,
): NonNullable<EffectiveRuntimeState['decision']> {
  return {
    ...readyDecision,
    requestedMode: runtimePolicy.authoredValue,
    effectiveMode: runtimePolicy.effectiveValue,
    runtimePolicy,
    chatOverride,
  }
}

let hookState: EffectiveRuntimeState

mock.module('@/hooks/useEffectiveRuntime', () => ({
  useEffectiveRuntime: () => hookState,
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'agentRuntime.provenance.resolutionError.target') {
        return `${String(options?.generationType)} ${String(options?.messageId)} ${String(options?.swipeId)}`
      }
      if (key === 'agentRuntime.provenance.resolutionError.code') return String(options?.code)
      return key
    },
  }),
}))
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

// The hook and translation mocks must be installed before the component captures them.
const { default: AgentRuntimeModeControl } = await import('./AgentRuntimeModeControl')
const { createRoot } = await import('react-dom/client')
mock.restore()
const mountedRoots = new Set<Root>()

function baseState(overrides: Partial<EffectiveRuntimeState> = {}): EffectiveRuntimeState {
  return {
    decision: readyDecision,
    inspection: readyDecision.inspection,
    responseOmission: readyDecision.responseOmission,
    mode: 'response',
    oneTurnMode: null,
    loading: false,
    savingOverride: false,
    activeGenerationMode: null,
    error: null,
    canShowSelector: true,
    repairCategories: [],
    selectOneTurnMode(mode) {
      selectCalls.push(mode)
    },
    async saveChatOverride(mode) {
      overrideCalls.push(mode)
    },
    async refresh() {
      refreshCalls.push('refresh')
    },
    ...overrides,
  }
}

async function renderControl(chatId = 'chat-1'): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(<AgentRuntimeModeControl chatId={chatId} generationType="normal" />)
  })
  return { host, root }
}

beforeEach(() => {
  hookState = baseState()
  selectCalls.length = 0
  overrideCalls.length = 0
  refreshCalls.length = 0
})

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount())
  }
  mountedRoots.clear()
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
  dom.window.close()
})

describe('AgentRuntimeModeControl', () => {
  test('hides Agentic controls until both modes and the complete readiness union are ready', async () => {
    hookState = baseState({ canShowSelector: false, decision: null })
    const { host } = await renderControl()
    expect(host.querySelector('input[value="agentic"]')).toBeNull()
    expect(host.textContent).toBe('')
  })

  test('defaults to Response and keeps the one-turn choice separate from the durable override', async () => {
    const { host } = await renderControl()
    const response = host.querySelector<HTMLInputElement>('input[value="response"]')
    const agentic = host.querySelector<HTMLInputElement>('input[value="agentic"]')
    expect(response?.checked).toBeTrue()
    expect(agentic?.checked).toBeFalse()

    await act(async () => agentic?.click())
    expect(selectCalls).toEqual(['agentic'])
    expect(overrideCalls).toEqual([])

    selectCalls.length = 0
    const durable = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    await act(async () => durable?.click())
    expect(overrideCalls).toEqual(['response'])
    expect(selectCalls).toEqual([])
  })

  test('shows stable repair categories and requires an explicit Response escape', async () => {
    hookState = baseState({
      decision: {
        ...readyDecision,
        effectiveMode: 'response',
        capabilityReadiness: {
          ...readyDecision.capabilityReadiness,
          ready: false,
          repairCodes: ['agentic_slot_unresolved', 'agentic_domain_mismatch'],
        },
        repairCodes: ['agentic_readiness_unavailable'],
      },
      oneTurnMode: 'agentic',
      mode: 'agentic',
      canShowSelector: false,
      repairCategories: ['slot', 'isolate', 'egress'],
    })
    const { host } = await renderControl()

    expect(host.querySelector('input[value="agentic"]')).toBeNull()
    expect(host.textContent).toContain('agentRuntime.repair.slot')
    expect(host.textContent).toContain('agentRuntime.repair.isolate')
    expect(host.textContent).toContain('agentRuntime.repair.egress')
    expect(selectCalls).toEqual([])

    const responseEscape = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useResponse'))
    responseEscape?.focus()
    expect(document.activeElement).toBe(responseEscape)
    await act(async () => responseEscape?.click())
    expect(selectCalls).toEqual(['response'])
  })

  test('hides the repair banner after an explicit Response escape', async () => {
    hookState = baseState({
      decision: {
        ...readyDecision,
        effectiveMode: 'response',
        capabilityReadiness: {
          ...readyDecision.capabilityReadiness,
          ready: false,
          repairCodes: ['agentic_readiness_unavailable'],
        },
        repairCodes: ['agentic_kill_switch'],
      },
      oneTurnMode: 'response',
      mode: 'response',
      canShowSelector: false,
      repairCategories: ['readiness', 'isolate'],
    })
    const { host } = await renderControl()
    expect(host.textContent).not.toContain('agentRuntime.repair.title')
    expect(host.querySelector('button')).toBeNull()
  })

  test('keeps the mode selector after Response escape when both modes are available', async () => {
    hookState = baseState({
      decision: {
        ...readyDecision,
        effectiveMode: 'response',
        capabilityReadiness: {
          ...readyDecision.capabilityReadiness,
          ready: false,
          repairCodes: ['agentic_kill_switch'],
        },
        repairCodes: ['agentic_kill_switch'],
      },
      oneTurnMode: 'response',
      mode: 'response',
      canShowSelector: true,
      repairCategories: ['readiness'],
    })
    const { host } = await renderControl()
    expect(host.querySelector('input[value="agentic"]')).not.toBeNull()
    expect(host.textContent).not.toContain('agentRuntime.repair.title')
  })

  test('uses semantic radio controls and one atomic polite announcement region', async () => {
    const { host } = await renderControl()
    expect(host.querySelector('fieldset')).not.toBeNull()
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    const liveRegions = host.querySelectorAll('[role="status"][aria-live="polite"][aria-atomic="true"]')
    expect(liveRegions).toHaveLength(1)
  })

  test('keeps next-turn selection available but locks durable chat policy while WORK is active', async () => {
    hookState = baseState({
      decision: decisionFor(policyFor({
        source: 'authenticated_one_turn',
        scope: 'turn',
        transientSelection: { mode: 'response', turnFence: 2, authenticated: true },
      })),
      activeGenerationMode: 'agentic',
      pendingOneTurnMode: 'response',
      canResetChatOverride: true,
      async resetChatOverride() {},
    })
    const { host } = await renderControl()
    const response = host.querySelector<HTMLInputElement>('input[value="response"]')
    const agentic = host.querySelector<HTMLInputElement>('input[value="agentic"]')
    const durable = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    const reset = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.resetToPreset'))

    expect(response?.disabled).toBeFalse()
    expect(agentic?.disabled).toBeFalse()
    expect(durable?.disabled).toBeTrue()
    expect(reset?.disabled).toBeTrue()
    expect(host.textContent).toContain('agentRuntime.nextTurnQueued')

    await act(async () => agentic?.click())
    await act(async () => durable?.click())
    expect(selectCalls).toEqual(['agentic'])
    expect(overrideCalls).toEqual([])
  })

  test('locks durable chat policy during an active Response generation', async () => {
    hookState = baseState({
      activeGenerationMode: 'response',
      canResetChatOverride: true,
      async resetChatOverride() {},
    })
    const { host } = await renderControl()
    const durable = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    const reset = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.resetToPreset'))
    expect(durable?.disabled).toBeTrue()
    expect(reset?.disabled).toBeTrue()
  })

  test('shows the exact failed target, stable code, retry, and Response escape', async () => {
    hookState = baseState({
      decision: null,
      error: Object.assign(new Error('Cannot resolve exact target'), { name: 'TargetConflict' }),
      canShowSelector: false,
      oneTurnMode: 'agentic',
    })
    const { host } = await renderControl()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('TargetConflict')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('normal')
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.provenance.resolutionError.retry'))
    const response = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useResponse'))
    await act(async () => retry?.click())
    await act(async () => response?.click())
    expect(refreshCalls).toEqual(['refresh'])
    expect(selectCalls).toEqual(['response'])
  })

  test('renders canonical source and scope labels without inferring preset authority', async () => {
    const cases = [
      {
        source: 'reviewed_preset_default' as const,
        scope: 'preset' as const,
        sourceKey: 'sourceReviewedPresetDefault',
        scopeKey: 'scopePreset',
        authoredValue: 'response' as const,
        effectiveValue: 'response' as const,
      },
      {
        source: 'durable_chat_override' as const,
        scope: 'chat' as const,
        sourceKey: 'sourceDurableChatOverride',
        scopeKey: 'scopeChat',
        authoredValue: 'agentic' as const,
        effectiveValue: 'agentic' as const,
        durableChatOverride: {
          mode: 'agentic' as const,
          revision: 4,
          state: 'ready' as const,
          reviewCode: null,
          acknowledged: true,
        },
      },
      {
        source: 'response_fallback' as const,
        scope: 'fallback' as const,
        sourceKey: 'sourceResponseFallback',
        scopeKey: 'scopeFallback',
        authoredValue: 'response' as const,
        effectiveValue: 'response' as const,
      },
      {
        source: 'host_cap' as const,
        scope: 'host' as const,
        sourceKey: 'sourceHostCap',
        scopeKey: 'scopeHost',
        authoredValue: 'agentic' as const,
        effectiveValue: 'response' as const,
        cap: { authority: 'host' as const, allowedModes: ['response' as const], reasonCode: 'agentic_mode_not_allowed' as const },
        availability: { state: 'denied' as const, reasonCode: 'agentic_mode_not_allowed' as const },
      },
      {
        source: 'host_rejected' as const,
        scope: 'host' as const,
        sourceKey: 'sourceHostRejected',
        scopeKey: 'scopeHost',
        authoredValue: 'agentic' as const,
        effectiveValue: 'response' as const,
        cap: { authority: 'host' as const, allowedModes: ['response' as const], reasonCode: 'loom_policy_unavailable' as const },
        availability: { state: 'unavailable' as const, reasonCode: 'loom_policy_unavailable' as const },
      },
      {
        source: 'authenticated_one_turn' as const,
        scope: 'turn' as const,
        sourceKey: 'sourceAuthenticatedOneTurn',
        scopeKey: 'scopeTurn',
        authoredValue: 'agentic' as const,
        effectiveValue: 'agentic' as const,
        transientSelection: { mode: 'agentic' as const, turnFence: 8, authenticated: true as const },
      },
    ]

    for (const entry of cases) {
      hookState = baseState({
        decision: decisionFor(policyFor(entry), {
          mode: 'agentic',
          revision: 6,
          state: 'ready',
          reviewCode: null,
          acknowledged: true,
        }),
      })
      const { host } = await renderControl()
      expect(host.textContent).toContain(`agentRuntime.provenance.${entry.sourceKey}`)
      expect(host.textContent).toContain(`agentRuntime.provenance.${entry.scopeKey}`)
      expect(host.textContent).not.toContain('agentRuntime.provenance.sourcePreset')
      expect(host.textContent).not.toContain('agentRuntime.provenance.authorityPreset')
    }
  })

  test('shows availability, cap, reason, and repair acknowledgement truth', async () => {
    hookState = baseState({
      decision: decisionFor(policyFor({
        source: 'host_rejected',
        scope: 'host',
        authoredValue: 'agentic',
        effectiveValue: 'response',
        cap: {
          authority: 'host',
          allowedModes: ['response'],
          reasonCode: 'loom_policy_invalid',
        },
        availability: {
          state: 'invalid',
          reasonCode: 'loom_policy_invalid',
        },
        repairAcknowledgement: {
          state: 'required',
          presetRevision: 9,
          reasonCode: 'foreign_import',
          acknowledgedAt: null,
        },
      })),
    })
    const { host } = await renderControl()
    expect(host.textContent).toContain('agentRuntime.provenance.availabilityInvalid')
    expect(host.textContent).toContain('agentRuntime.provenance.capReasonCode')
    expect(host.textContent).toContain('agentRuntime.provenance.availabilityReasonCode')
    expect(host.textContent).toContain('agentRuntime.provenance.repairAcknowledgementRequired')
    expect(host.textContent).toContain('loom_policy_invalid')
    expect(host.textContent).toContain('foreign_import')
  })

  test('keeps a pending badge only when the canonical transient policy agrees', async () => {
    hookState = baseState({
      pendingOneTurnMode: 'agentic',
    })
    const { host } = await renderControl()
    expect(host.textContent).not.toContain('agentRuntime.nextTurnQueued')

    hookState = baseState({
      decision: decisionFor(policyFor({
        source: 'authenticated_one_turn',
        scope: 'turn',
        authoredValue: 'agentic',
        effectiveValue: 'agentic',
        transientSelection: { mode: 'agentic', turnFence: 10, authenticated: true },
      })),
      pendingOneTurnMode: 'agentic',
    })
    const agreed = await renderControl()
    expect(agreed.host.textContent).toContain('agentRuntime.nextTurnQueued')
  })

  test('shows a failed save and retries the exact mode without changing accepted state', async () => {
    let attempts = 0
    hookState = baseState({
      async saveChatOverride(mode) {
        overrideCalls.push(mode)
        attempts += 1
        if (attempts === 1) throw new Error('save failed')
      },
    })
    const { host } = await renderControl()
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChatMode'))
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agentRuntime.overrideError.action')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agentRuntime.overrideError.retry')
    expect(hookState.decision).toBe(readyDecision)
    expect(hookState.mode).toBe('response')

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.overrideError.retry'))
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response', 'response'])
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(hookState.decision).toBe(readyDecision)
    expect(hookState.mode).toBe('response')
  })

  test('shows a failed reset and retries the exact reset without changing accepted state', async () => {
    let attempts = 0
    const chatOverride = {
      mode: 'agentic' as const,
      revision: 4,
      state: 'ready' as const,
      reviewCode: null,
      acknowledged: true,
    }
    hookState = baseState({
      decision: decisionFor(policyFor({
        source: 'durable_chat_override',
        scope: 'chat',
        authoredValue: 'agentic',
        effectiveValue: 'agentic',
        durableChatOverride: chatOverride,
      }), chatOverride),
      canResetChatOverride: true,
      async resetChatOverride() {
        attempts += 1
        if (attempts === 1) throw new Error('reset failed')
      },
    })
    const acceptedDecision = hookState.decision
    const { host } = await renderControl()
    const reset = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.resetToPreset'))
    await act(async () => {
      reset?.click()
      await Promise.resolve()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agentRuntime.overrideError.action')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agentRuntime.overrideError.retry')
    expect(hookState.decision).toBe(acceptedDecision)

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.overrideError.retry'))
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(attempts).toBe(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(hookState.decision?.runtimePolicy.source).toBe('durable_chat_override')
  })

  test('prevents duplicate durable writes while a save is in flight', async () => {
    let resolveWrite!: () => void
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    hookState = baseState({
      async saveChatOverride(mode) {
        overrideCalls.push(mode)
        await pendingWrite
      },
    })
    const { host } = await renderControl()
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response'])
    expect(save?.disabled).toBeTrue()
    await act(async () => {
      resolveWrite()
      await pendingWrite
    })
    expect(overrideCalls).toEqual(['response'])
    expect(hookState.decision).toBe(readyDecision)
  })
  test('keeps durable retry attached when radio changes during deferred save', async () => {
    let rejectFirst!: (error: Error) => void
    let attempts = 0
    const pendingSave = new Promise<void>((_, reject) => {
      rejectFirst = reject
    })
    hookState = baseState({
      async saveChatOverride(mode) {
        overrideCalls.push(mode)
        attempts += 1
        if (attempts === 1) await pendingSave
      },
    })
    const { host } = await renderControl()
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[value="agentic"]')?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response'])

    await act(async () => {
      rejectFirst(new Error('save failed'))
      await Promise.resolve()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agentRuntime.overrideError.retry')

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.overrideError.retry'))
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response', 'response'])
  })

  test('clears durable action state and ignores late completion after chat changes', async () => {
    let resetCalls = 0
    let rejectSave!: (error: Error) => void
    const pendingSave = new Promise<void>((_, reject) => {
      rejectSave = reject
    })
    hookState = baseState({
      async saveChatOverride(mode) {
        overrideCalls.push(mode)
        await pendingSave
      },
    })
    const { host, root } = await renderControl('chat-1')
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    hookState = baseState()
    await act(async () => {
      root.render(<AgentRuntimeModeControl chatId="chat-2" generationType="normal" />)
      await Promise.resolve()
    })
    expect(host.textContent).toBe('')
    expect(host.querySelector('[role="alert"]')).toBeNull()

    const chatOverride = {
      mode: 'agentic' as const,
      revision: 4,
      state: 'ready' as const,
      reviewCode: null,
      acknowledged: true,
    }
    const nextChatDecision = {
      ...decisionFor(policyFor({
        source: 'durable_chat_override',
        scope: 'chat',
        authoredValue: 'agentic',
        effectiveValue: 'agentic',
        durableChatOverride: chatOverride,
      }), chatOverride),
      chatId: 'chat-2',
    }
    hookState = baseState({
      decision: nextChatDecision,
      canResetChatOverride: true,
      async resetChatOverride() {
        resetCalls += 1
      },
    })
    await act(async () => {
      root.render(<AgentRuntimeModeControl chatId="chat-2" generationType="normal" />)
      await Promise.resolve()
    })
    expect(host.textContent).toContain('agentRuntime.provenance.sourceDurableChatOverride')
    const newChatSave = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.useForChat'))
    expect(newChatSave?.disabled).toBeFalse()
    await act(async () => {
      newChatSave?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response', 'agentic'])
    const newChatReset = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('agentRuntime.resetToPreset'))
    expect(newChatReset?.disabled).toBeFalse()
    await act(async () => {
      newChatReset?.click()
      await Promise.resolve()
    })
    expect(overrideCalls).toEqual(['response', 'agentic'])

    await act(async () => {
      rejectSave(new Error('late save failed'))
      await Promise.resolve()
    })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(overrideCalls).toEqual(['response', 'agentic'])
  })
})
