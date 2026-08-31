import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import en from '@/i18n/locales/en/chat.json'
import fr from '@/i18n/locales/fr/chat.json'
import it from '@/i18n/locales/it/chat.json'
import ja from '@/i18n/locales/ja/chat.json'
import zh from '@/i18n/locales/zh/chat.json'
import zhTW from '@/i18n/locales/zh-TW/chat.json'

import { WORKSPACE_CAPABILITIES } from '@/lib/loom/types'
import type { AgentPromptEvidenceDestinationV1 } from '@/types/agent-runs'

const activitySource = readFileSync(resolve(import.meta.dir, 'AgentRunActivity.tsx'), 'utf8')
const backendSource = readFileSync(resolve(import.meta.dir, '../../../../src/types/agent-runtime.ts'), 'utf8')

function publicErrorCodesFromActivitySource(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'AgentRunActivity.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'AGENT_PUBLIC_ERROR_LABEL_KEYS') continue
      const initializer = declaration.initializer
      const objectLiteral =
        initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer
      if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
        throw new Error('AgentRunActivity public error allowlist is not an object')
      }
      return objectLiteral.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) {
          throw new Error('AgentRunActivity public error allowlist contains a non-property member')
        }
        const name = property.name
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
          throw new Error('AgentRunActivity public error allowlist contains an invalid property name')
        }
        return name.text
      })
    }
  }
  throw new Error('AgentRunActivity public error allowlist not found')
}

function publicErrorCodesFromBackendSource(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'agent-runtime.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'AGENT_PUBLIC_ERROR_CODES') continue
      let initializer = declaration.initializer
      while (
        initializer
        && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))
      ) {
        initializer = initializer.expression
      }
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error('Backend public error code list is not an array')
      }
      return initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) {
          throw new Error('Backend public error code list contains a non-string member')
        }
        return element.text
      })
    }
  }
  throw new Error('Backend public error code list not found')
}

const BACKEND_PUBLIC_ERROR_CODES = publicErrorCodesFromBackendSource(backendSource)

const PUBLIC_ERROR_CODES = publicErrorCodesFromActivitySource(activitySource)

const WORKSPACE_CAPABILITY_TOOL_IDS = [
  'workspace_read_section',
  'workspace_read_page',
  'workspace_create_task',
  'workspace_update_progress',
  'workspace_submit_result',
  'workspace_submit_root_result',
  'workspace_accept_submission',
  'workspace_record_finding',
  'workspace_record_decision',
  'workspace_record_question',
  'workspace_attach_artifact',
  'workspace_propose_publication',
] as const

const DURATION_LABEL_KEYS = [
  'seconds',
  'minutes',
  'minutesSeconds',
  'hours',
  'hoursMinutes',
] as const

const PROMPT_EVIDENCE_DESTINATIONS = [
  'root_work',
  'child_work',
  'completion_handoff',
  'render',
  'council',
  'cortex',
] as const satisfies readonly AgentPromptEvidenceDestinationV1[]

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

const OWNER_ERROR_VALUE_KEYS = [
  'ADMIT', 'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMIT',
  'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED',
  'TIMED_OUT', 'TERMINAL', 'pending', 'running', 'waiting', 'cancelling', 'terminal',
  'completed', 'stopped', 'failed', 'exhausted', 'rejected', 'none', 'user_stop',
  'deadline', 'provider_failure', 'tool_failure', 'required_work_failure',
  'budget_exhausted', 'invalid_input', 'stale_input', 'unavailable', 'needs_attention',
  'interrupted', 'retry_requested', 'reconciled', 'unknown', 'capacity', 'budget',
  'context', 'integrity', 'timeout', 'cancelled', 'provider', 'validation', 'internal',
  'host', 'preset', 'owner', 'system', 'cortex', 'council', 'execution', 'projection',
  'tool', 'recovery', 'run', 'attempt', 'turn_session', 'target', 'phase', 'usage',
  'transcript', 'workspace',
] as const

describe('AgentRunActivity locale coverage', () => {
  test('keeps the complete Agentic activity and workspace key set in all six locales', () => {
    const expected = leafPaths(en.agentRun)
    const expectedActivity = leafPaths(en.agentActivity)
    expect(PUBLIC_ERROR_CODES.length).toBeGreaterThan(0)
    expect(PUBLIC_ERROR_CODES).toEqual(BACKEND_PUBLIC_ERROR_CODES)
    const expectedErrorKeys = Object.keys(en.agentRun.errors).sort()
    const expectedOwnerInspection = leafPaths(en.ownerInspection)
    const expectedPersistentWorkspace = leafPaths(en.persistentWorkspace)
    for (const key of ['unknown', ...BACKEND_PUBLIC_ERROR_CODES]) {
      expect(expectedErrorKeys).toContain(key)
    }
    const locales = [en, fr, it, ja, zh, zhTW]
    for (const locale of locales) {
      expect(leafPaths(locale.agentActivity)).toEqual(expectedActivity)
      expect('errors' in locale.agentActivity).toBeFalse()
      const rootResultLabel = locale.agentActivity.tools.workspace_submit_root_result
      expect(rootResultLabel, 'workspace_submit_root_result legacy activity label').toBeString()
      expect(rootResultLabel.trim()).not.toBe('')
      expect(leafPaths(locale.agentRun)).toEqual(expected)
      expect(leafPaths(locale.ownerInspection)).toEqual(expectedOwnerInspection)
      expect(leafPaths(locale.persistentWorkspace)).toEqual(expectedPersistentWorkspace)
      expect(locale.ownerInspection.resolutionError.title.trim()).not.toBe('')
      expect(locale.ownerInspection.resolutionError.code).toContain('{{code}}')
      expect(locale.persistentWorkspace.label.trim()).not.toBe('')
      expect(locale.persistentWorkspace.creators.owner.trim()).not.toBe('')
      expect(locale.persistentWorkspace.sessionStatus.terminal.trim()).not.toBe('')
      const ownerValues = locale.ownerInspection.values as Record<string, unknown>
      for (const key of OWNER_ERROR_VALUE_KEYS) {
        const label = ownerValues[key]
        expect(label, key + ' owner error-state label').toBeString()
        if (typeof label === 'string') expect(label.trim()).not.toBe('')
      }
      const errors = locale.agentRun.errors as Record<string, unknown>
      expect(errors.invalid_input).not.toBe(errors.unknown)
      expect(Object.keys(errors).sort()).toEqual(expectedErrorKeys)
      for (const key of expectedErrorKeys) {
        const label = errors[key]
        expect(label).toBeString()
        if (typeof label === 'string') expect(label.trim()).not.toBe('')
      }
      for (const destination of PROMPT_EVIDENCE_DESTINATIONS) {
        const label = ownerValues[destination]
        expect(label, `${destination} owner inspection label`).toBeString()
        if (typeof label === 'string') expect(label.trim()).not.toBe('')
      }
      for (const toolId of WORKSPACE_CAPABILITY_TOOL_IDS) {
        expect(locale.agentRun.tools[toolId], `${toolId} workspace label`).toBeString()
        expect(locale.agentRun.tools[toolId].trim()).not.toBe('')
      }
      for (const durationKey of DURATION_LABEL_KEYS) {
        expect(locale.agentRun.duration[durationKey], `${durationKey} duration label`).toBeString()
        expect(locale.agentRun.duration[durationKey].trim()).not.toBe('')
      }
    }
  })

  test('keeps mapped runtime error keys under agentRuntime.errors in all six locales', () => {
    const expectedErrorKeys = [
      'not_found',
      'invalid_request',
      'decision_refresh_required',
      'decision_capacity_exceeded',
      'runtime_decision_unavailable',
      'agentic_unsupported_surface',
      'agentic_runtime_unavailable',
      'agentic_preflight_failed',
      'agentic_chat_busy',
      'agentic_protocol_failure',
      'agentic_work_exhausted',
      'agentic_cancelled',
      'agentic_timed_out',
      'agentic_commit_failed',
      'agentic_revision_conflict',
      'agentic_provider_failure',
      'agentic_internal_error',
    ]
    const expectedResolutionError = leafPaths(en.agentRuntime.provenance.resolutionError)
    for (const locale of [en, fr, it, ja, zh, zhTW]) {
      const errors = locale.agentRuntime.errors as Record<string, unknown>
      expect('errors' in locale.agentActivity).toBeFalse()
      expect('resolutionError' in locale.agentRuntime).toBeFalse()
      expect(leafPaths(locale.agentRuntime.provenance.resolutionError)).toEqual(expectedResolutionError)
      expect(locale.agentRuntime.provenance.resolutionError.title.trim()).not.toBe('')
      expect(locale.agentRuntime.provenance.resolutionError.target).toContain('{{generationType}}')
      expect(locale.agentRuntime.provenance.resolutionError.code).toContain('{{code}}')
      expect(locale.agentRuntime.provenance.resolutionError.retry.trim()).not.toBe('')
      expect(Object.keys(errors).sort()).toEqual([...expectedErrorKeys].sort())
      for (const key of expectedErrorKeys) {
        const label = errors[key]
        expect(label).toBeString()
        if (typeof label === 'string') expect(label.trim()).not.toBe('')
      }
    }
  })

  test('keeps root-only workspace operations out of child profile grants', () => {
    expect(WORKSPACE_CAPABILITIES).toEqual([
      'read_section',
      'read_page',
      'update_assigned_progress',
      'submit_child_result',
    ])
  })
})
