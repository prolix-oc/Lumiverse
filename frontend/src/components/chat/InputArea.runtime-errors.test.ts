import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chat from '../../i18n/locales/en/chat.json'
import * as runtime from '@/lib/agentRuntimeSelection'

const inputAreaSource = readFileSync(resolve(import.meta.dir, 'InputArea.tsx'), 'utf8')

type GenerationErrorResolver = (
  error: unknown,
  fallback: string,
  translate: (key: string) => string,
) => string

function loadGenerationErrorResolver(): GenerationErrorResolver {
  const resolverSource = inputAreaSource.match(
    /function resolveGenerationErrorMessage\([\s\S]*?\n}\n/,
  )?.[0]
  if (!resolverSource) throw new Error('InputArea generation error resolver is missing')
  const javascript = new Bun.Transpiler({ loader: 'tsx' }).transformSync(resolverSource)
  const factory = new Function(
    'agentRuntimeErrorTranslationKey',
    'agentRuntimePreflightTranslationKey',
    `${javascript}\nreturn resolveGenerationErrorMessage`,
  ) as (
    errorKey: typeof runtime.agentRuntimeErrorTranslationKey,
    preflightKey: typeof runtime.agentRuntimePreflightTranslationKey,
  ) => GenerationErrorResolver
  return factory(
    runtime.agentRuntimeErrorTranslationKey,
    runtime.agentRuntimePreflightTranslationKey,
  )
}

function translateChatKey(key: string): string {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, chat)
  if (typeof value !== 'string') throw new Error(`Missing English chat translation: ${key}`)
  return value
}

describe('InputArea generation error routing', () => {
  test('routes send, regenerate, continue, and impersonate catches through the shared resolver', () => {
    expect(inputAreaSource).toContain("const { t } = useTranslation('chat')")
    const calls = inputAreaSource.match(
      /resolveGenerationErrorMessage\(err, te\('(failedToStartGeneration|failedToRegenerate|failedToContinue|failedToImpersonate)'\), t\)/g,
    ) ?? []

    expect(calls).toHaveLength(4)
    expect(calls).toEqual(expect.arrayContaining([
      "resolveGenerationErrorMessage(err, te('failedToStartGeneration'), t)",
      "resolveGenerationErrorMessage(err, te('failedToRegenerate'), t)",
      "resolveGenerationErrorMessage(err, te('failedToContinue'), t)",
      "resolveGenerationErrorMessage(err, te('failedToImpersonate'), t)",
    ]))
  })

  test('executes localized runtime and preflight mappings before raw fallback text', () => {
    const resolveError = loadGenerationErrorResolver()
    const translate = translateChatKey
    const providerKey = 'agentRuntime.errors.agentic_provider_failure'
    const slotKey = 'agentRuntime.repair.slot'
    const refreshKey = 'agentRuntime.preflight.refreshRequired'
    const unavailableKey = 'agentRuntime.preflight.unavailable'

    expect(translate(providerKey)).not.toBe(providerKey)
    expect(resolveError({ body: { code: 'AGENTIC_PROVIDER_FAILURE' } }, 'send fallback', translate))
      .toBe(translate(providerKey))
    expect(resolveError({ body: { code: 'AGENTIC_SLOT_UNRESOLVED' } }, 'regenerate fallback', translate))
      .toBe(translate(slotKey))
    expect(resolveError(
      new runtime.AgentRuntimePreflightError('decision_refresh_required', []),
      'continue fallback',
      translate,
    )).toBe(translate(refreshKey))
    expect(resolveError(
      new runtime.AgentRuntimePreflightError('agentic_unavailable', []),
      'impersonate fallback',
      translate,
    )).toBe(translate(unavailableKey))
    expect(resolveError(
      { body: { code: 'NEW_RUNTIME_FAILURE', error: 'raw provider text' } },
      'unknown fallback',
      translate,
    )).toBe('raw provider text')
    expect(resolveError({ message: 'raw server text' }, 'unknown fallback', translate))
      .toBe('raw server text')
    expect(resolveError('not an error object', 'unknown fallback', translate))
      .toBe('unknown fallback')
  })
})
