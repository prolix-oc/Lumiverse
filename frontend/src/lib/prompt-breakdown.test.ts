import { describe, expect, test } from 'bun:test'
import type { AgentRunInspectionDetailV1 } from '@/types/agent-runs'
import {
  inspectionAttemptTargetMessageId,
  inspectionDetailToBreakdown,
  workInspectionCheckpointLabel,
} from './prompt-breakdown'

describe('workInspectionCheckpointLabel', () => {
  test('never labels live WORK inspection as ordinary_response', () => {
    expect(workInspectionCheckpointLabel('WORK', undefined)).toBe('WORK')
    expect(workInspectionCheckpointLabel('WORK', null)).toBe('WORK')
    expect(workInspectionCheckpointLabel('WORK', 'ordinary_response')).toBe('WORK')
    expect(workInspectionCheckpointLabel('WORK', 'WORK')).toBe('WORK')
    expect(workInspectionCheckpointLabel('WORK', undefined, 'exercise_phase')).toBe('exercise_phase')
  })

  test('keeps Response ordinary_response fallback unchanged', () => {
    expect(workInspectionCheckpointLabel('RESPONSE', undefined)).toBe('ordinary_response')
    expect(workInspectionCheckpointLabel('RESPONSE', null)).toBe('ordinary_response')
    expect(workInspectionCheckpointLabel('RESPONSE', 'ASSEMBLE')).toBe('ASSEMBLE')
    expect(workInspectionCheckpointLabel(undefined, undefined)).toBe('ordinary_response')
  })
})

function inspectionDetail(overrides: Partial<AgentRunInspectionDetailV1> = {}): AgentRunInspectionDetailV1 {
  return {
    version: 1,
    attempt: {
      version: 1,
      attemptId: 'exhausted-attempt',
      previousAttemptId: null,
      target: {
        chatId: 'chat-1',
        generationType: 'normal',
        messageId: null,
        swipeId: null,
      },
      createdAt: 1,
    },
    runId: 'run-1',
    turnSessionId: 'turn-1',
    generationId: 'generation-1',
    hostCorrelationId: 'host-1',
    lifecycle: 'TERMINAL',
    status: 'terminal',
    outcome: 'exhausted',
    reason: 'budget_exhausted',
    target: null,
    committedTarget: null,
    revision: 1,
    startedAt: 1,
    updatedAt: 2,
    terminalAt: 2,
    activity: {
      version: 1,
      attempt: {
        version: 1,
        attemptId: 'exhausted-attempt',
        previousAttemptId: null,
        target: {
          chatId: 'chat-1',
          generationType: 'normal',
          messageId: null,
          swipeId: null,
        },
        createdAt: 1,
      },
      lifecycle: 'TERMINAL',
      status: 'terminal',
      outcome: 'exhausted',
      reason: 'budget_exhausted',
      revision: 1,
      startedAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      target: null,
      milestones: [],
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, toolCalls: 0, childInvocations: 0 },
      markers: [],
      reconciliation: 'authoritative',
    },
    markerCount: 0,
    transcriptCount: 0,
    terminal: true,
    transcript: [],
    turnSession: [],
    markers: [],
    usageEvidence: [],
    usage: {
      version: 1,
      inspectionAttemptId: 'exhausted-attempt',
      totals: { inputTokens: 1, outputTokens: 0, totalTokens: 1, toolCalls: 0, childInvocations: 0 },
      layers: [],
      evidenceCount: 0,
      omittedEvidenceCount: 0,
    },
    error: null,
    promptEvidence: [],
    renderCrossings: [],
    cortexReceipts: [],
    councilReceipts: [],
    workspaceAssociations: [],
    stop: null,
    retry: { allowed: true, reason: 'budget_exhausted', targetValid: true, linkedAttemptId: null },
    sectionAvailability: [],
    workSegments: null,
    ...overrides,
  } as AgentRunInspectionDetailV1
}

describe('inspectionDetailToBreakdown', () => {
  test('keeps exact attempt WORK inspection without requiring a message target', () => {
    const correlation = {
      turnSessionId: 'turn-1',
      runId: 'run-1',
      attemptId: 'exhausted-attempt',
      chatId: 'chat-1',
      generationId: 'generation-1',
      messageId: null,
      swipeId: null,
      actorId: 'host',
      recipientId: 'agent',
      phase: 'WORK',
      taskId: null,
      toolId: null,
      parentId: null,
      hostCorrelationId: 'host-1',
      hostSequence: 1,
    } as const
    const breakdown = inspectionDetailToBreakdown(inspectionDetail({
      promptEvidence: [{
        version: 1,
        id: 'prompt-root',
        sourceId: 'loom-root',
        sourceRevision: 3,
        promptOrder: 0,
        destination: 'root_work',
        role: 'system',
        correlation,
        included: true,
        content: 'ROOT_WORK_PROMPT',
        contentDigest: 'a'.repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: {
          version: 1,
          surface: 'WORK',
          checkpoint: 'WORK',
          items: [],
          effectiveEntryIds: ['loom-root'],
        },
      }, {
        version: 1,
        id: 'prompt-handoff',
        sourceId: 'phase-continuation',
        sourceRevision: 3,
        destination: 'completion_handoff',
        role: 'system',
        promptOrder: 0,
        correlation: { ...correlation, hostSequence: 2 },
        included: true,
        content: 'PHASE_CONTINUATION',
        contentDigest: 'b'.repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: {
          version: 1,
          surface: 'WORK',
          checkpoint: 'PREPARE_COMMIT',
          items: [],
          effectiveEntryIds: ['phase-continuation'],
        },
      }, {
        version: 1,
        id: 'prompt-cortex',
        sourceId: 'cortex-private',
        sourceRevision: 1,
        destination: 'cortex',
        role: 'system',
        correlation: { ...correlation, hostSequence: 3 },
        included: true,
        promptOrder: 0,
        content: 'PRIVATE_CORTEX',
        contentDigest: 'c'.repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: null,
      }],
    }))
    expect(breakdown.assemblySurface).toBe('WORK')
    expect(breakdown.loomPromptInspection?.checkpoint).toBe('WORK')
    expect(breakdown.entries.map((entry) => entry.content)).toEqual(['ROOT_WORK_PROMPT', 'PHASE_CONTINUATION'])
    expect(breakdown.entries.map((entry) => entry.promptOrder)).toEqual([0, 0])
    expect(JSON.stringify(breakdown)).not.toContain('PRIVATE_CORTEX')
    expect(workInspectionCheckpointLabel(breakdown.assemblySurface, breakdown.loomPromptInspection?.checkpoint)).toBe('WORK')
    expect(inspectionAttemptTargetMessageId({ target: null, committedTarget: null })).toBeNull()
  })
})
