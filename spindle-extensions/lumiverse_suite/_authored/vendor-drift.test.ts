import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  authoredTokenEstimate,
  ESTIMATE_CHARS_PER_TOKEN,
} from './token-estimate'

const corePath = join(import.meta.dir, '../../../frontend/src/lib/tokenEstimate.ts')
const hasCore = existsSync(corePath)

const supportedContent: readonly (string | null | undefined)[] = [
  null,
  undefined,
  '',
  'a',
  'abcd',
  'abcde',
  '🙂🙂🙂',
  'x'.repeat(401),
]

const unsupportedContent: readonly unknown[] = [0, false, { length: 4 }, ['text']]

test.skipIf(!hasCore)('keeps the authored token mirror aligned with the current core source contract', async () => {
  const { ESTIMATE_CHARS_PER_TOKEN: CORE_ESTIMATE_CHARS_PER_TOKEN } = await import(
    '../../../frontend/src/lib/tokenEstimate'
  )
  const authoredSourceUrl = new URL('./token-estimate.ts', import.meta.url)
  const [coreSource, authoredSource] = await Promise.all([
    Bun.file(corePath).text(),
    Bun.file(authoredSourceUrl).text(),
  ])

  expect(CORE_ESTIMATE_CHARS_PER_TOKEN).toBe(4)
  expect(ESTIMATE_CHARS_PER_TOKEN).toBe(CORE_ESTIMATE_CHARS_PER_TOKEN)
  expect(coreSource).toContain('export const ESTIMATE_CHARS_PER_TOKEN = 4')
  expect(authoredSource).toContain('export const ESTIMATE_CHARS_PER_TOKEN = 4')
  expect(coreSource).toContain('Math.ceil(content.length / ESTIMATE_CHARS_PER_TOKEN)')
  expect(authoredSource).toContain('Math.ceil(content.length / ESTIMATE_CHARS_PER_TOKEN)')
})

test.skipIf(!hasCore)('matches current core token estimate behavior for supported content', async () => {
  const { estimateTokens: coreEstimateTokens } = await import('../../../frontend/src/lib/tokenEstimate')
  for (const content of supportedContent) {
    expect(authoredTokenEstimate(content)).toBe(coreEstimateTokens(content))
  }
})

test.skipIf(!hasCore)('matches current core errors for unsupported content', async () => {
  const { estimateTokens: coreEstimateTokens } = await import('../../../frontend/src/lib/tokenEstimate')
  for (const content of unsupportedContent) {
    expect(() => authoredTokenEstimate(content as never)).toThrow(TypeError)
    expect(() => coreEstimateTokens(content as never)).toThrow(TypeError)
  }
})
