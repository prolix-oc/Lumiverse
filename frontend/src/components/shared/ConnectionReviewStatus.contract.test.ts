import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { focusConnectionReviewTarget } from './ConnectionReviewStatus'

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
}

describe('connection review UI contract', () => {
  test('keeps review copy complete in all six locales', () => {
    const locales = ['en', 'zh', 'zh-TW', 'ja', 'fr', 'it']
    const load = (locale: string) => {
      const value = JSON.parse(readFileSync(resolve(import.meta.dir, `../../i18n/locales/${locale}/panels.json`), 'utf8')) as Record<string, unknown>
      return value.connectionReview
    }
    const expected = leafKeys(load('en')).sort()
    for (const locale of locales) {
      const review = load(locale)
      expect(leafKeys(review).sort(), `${locale} connection review keys`).toEqual(expected)
      for (const key of expected) {
        const value = key.split('.').reduce<unknown>((current, segment) => (
          current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined
        ), review)
        expect(typeof value, `${locale}.${key}`).toBe('string')
        expect((value as string).trim(), `${locale}.${key}`).not.toBe('')
      }
    }
  })

  test('restores keyboard focus to the stable row control after review', () => {
    let focused = false
    const target = { current: { focus: () => { focused = true } } } as unknown as { current: HTMLElement }
    focusConnectionReviewTarget(target)
    expect(focused).toBe(true)
  })

  test('ignores an unknown review code instead of rendering it', () => {
    const value = JSON.parse(readFileSync(resolve(import.meta.dir, '../../i18n/locales/en/panels.json'), 'utf8')) as { connectionReview: { reasons: { unknown: string } } }
    expect(value.connectionReview.reasons.unknown).not.toContain('unknown_code')
  })
})
