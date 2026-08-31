import { describe, expect, test } from 'bun:test'

import { normalizeAgentActivityPayload, reconcileAgentActivityState, agentActivityGenerationKey } from './chat'

const started = {
  generationId: 'generation-1',
  invocationId: 'invocation-1',
  actor: 'child_profile',
  profileName: 'Researcher',
  phase: 'started',
  status: 'running',
  startedAt: 1_000,
  elapsedMs: 250,
} as const

describe('agent activity reconciliation', () => {
  test('keeps stable invocation order while updating phase and cumulative usage', () => {
    const first = reconcileAgentActivityState({}, started)
    const withChild = reconcileAgentActivityState(first, {
      ...started,
      invocationId: 'tool-1',
      parentInvocationId: 'invocation-1',
      phase: 'tool_call',
      toolName: 'lore_search_entries',
      elapsedMs: 500,
    })
    const completedTool = reconcileAgentActivityState(withChild, {
      ...started,
      invocationId: 'tool-1',
      parentInvocationId: 'invocation-1',
      phase: 'completed',
      status: 'succeeded',
      elapsedMs: 700,
    })
    const updated = reconcileAgentActivityState(completedTool, {
      ...started,
      phase: 'completed',
      status: 'succeeded',
      elapsedMs: 900,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })

    expect(updated[agentActivityGenerationKey('generation-1')].invocationOrder).toEqual(['invocation-1', 'tool-1'])
    expect(updated[agentActivityGenerationKey('generation-1')].invocations['invocation-1']).toEqual({
      invocationId: 'invocation-1',
      actor: 'child_profile',
      profileName: 'Researcher',
      phase: 'completed',
      status: 'succeeded',
      startedAt: 1_000,
      elapsedMs: 900,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
    expect(updated[agentActivityGenerationKey('generation-1')].invocations['tool-1'].parentInvocationId).toBe('invocation-1')
    expect(updated[agentActivityGenerationKey('generation-1')].invocations['tool-1'].toolName).toBe('lore_search_entries')
  })

  test('isolates concurrent generation IDs', () => {
    const first = reconcileAgentActivityState({}, started)
    const second = reconcileAgentActivityState(first, {
      ...started,
      generationId: 'generation-2',
      invocationId: 'invocation-2',
    })

    expect(Object.keys(second)).toEqual([agentActivityGenerationKey('generation-1'), agentActivityGenerationKey('generation-2')])
    expect(second[agentActivityGenerationKey('generation-1')].invocationOrder).toEqual(['invocation-1'])
    expect(second[agentActivityGenerationKey('generation-2')].invocationOrder).toEqual(['invocation-2'])
  })

  test('rejects unknown phases, tools, and malformed usage without storing arbitrary payload fields', () => {
    expect(normalizeAgentActivityPayload({ ...started, phase: 'show_task', task: 'private' })).toBeNull()
    expect(normalizeAgentActivityPayload({ ...started, actor: 'unknown_actor' })).toBeNull()
    expect(normalizeAgentActivityPayload({ ...started, actor: 'main_model' })).not.toBeNull()
    const { profileName: _profileName, ...mainActivity } = started
    expect(normalizeAgentActivityPayload({ ...mainActivity, actor: 'child_profile' })).toBeNull()
    expect(normalizeAgentActivityPayload({ ...mainActivity, actor: 'main_model' })).not.toBeNull()
    expect(normalizeAgentActivityPayload({ ...started, toolName: 'unknown_tool' })).toBeNull()
    expect(normalizeAgentActivityPayload({
      ...started,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: '3' },
    })).toBeNull()

    const normalized = normalizeAgentActivityPayload({ ...started, task: 'private', result: 'private' })
    expect(normalized).toEqual(started)
  })

  test('keeps approved activity error codes and omits unknown codes without vanishing', () => {
    expect(normalizeAgentActivityPayload({
      ...started,
      errorCode: 'child_output_limit_exceeded',
    })).toMatchObject({ errorCode: 'child_output_limit_exceeded' })
    expect(normalizeAgentActivityPayload({
      ...started,
      errorCode: 'child_required_failed',
    })).toMatchObject({ errorCode: 'child_required_failed' })
    expect(normalizeAgentActivityPayload({
      ...started,
      errorCode: 'agentic_protocol_failure',
    })).toMatchObject({ errorCode: 'agentic_protocol_failure' })
    const unknown = normalizeAgentActivityPayload({
      ...started,
      errorCode: 'secret_internal_code',
    })
    expect(unknown).not.toBeNull()
    expect(unknown).not.toHaveProperty('errorCode')
  })
})
