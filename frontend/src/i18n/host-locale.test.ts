import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  getHostLocale,
  normalizeHostLocale,
  setHostLocale,
  subscribeHostLocale,
} from './host-locale'

function resetLocale(): void {
  setHostLocale('en')
}

afterEach(resetLocale)

describe('host locale API', () => {
  test('normalizes all supported browser and i18next variants', () => {
    expect(normalizeHostLocale('en')).toBe('en')
    expect(normalizeHostLocale('en-US')).toBe('en')
    expect(normalizeHostLocale('zh-CN')).toBe('zh')
    expect(normalizeHostLocale('zh_TW')).toBe('zh-TW')
    expect(normalizeHostLocale('zh-TW-u-nu-latn')).toBe('zh-TW')
    expect(normalizeHostLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeHostLocale('ja-JP')).toBe('ja')
    expect(normalizeHostLocale('fr-CA')).toBe('fr')
    expect(normalizeHostLocale('it-IT')).toBe('it')
    expect(normalizeHostLocale('de-DE')).toBe('en')
    expect(normalizeHostLocale(undefined)).toBe('en')
  })

  test('provides synchronous reads and live updates until idempotent removal', () => {
    const updates: string[] = []
    const unsubscribe = subscribeHostLocale((locale) => updates.push(locale))

    expect(getHostLocale()).toBe('en')
    setHostLocale('ja-JP')
    expect(getHostLocale()).toBe('ja')
    expect(updates).toEqual(['ja'])

    unsubscribe()
    unsubscribe()
    setHostLocale('fr-FR')
    expect(getHostLocale()).toBe('fr')
    expect(updates).toEqual(['ja'])
  })

  test('keeps duplicate callback subscriptions independent', () => {
    const updates: string[] = []
    const listener = (locale: string) => updates.push(locale)
    const unsubscribeFirst = subscribeHostLocale(listener)
    const unsubscribeSecond = subscribeHostLocale(listener)

    setHostLocale('zh-TW')
    expect(updates).toEqual(['zh-TW', 'zh-TW'])
    unsubscribeFirst()
    setHostLocale('ja')
    expect(updates).toEqual(['zh-TW', 'zh-TW', 'ja'])
    unsubscribeSecond()
  })

  test('isolates throwing subscribers so later listeners still receive updates', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const updates: string[] = []
    const unsubscribeThrowing = subscribeHostLocale(() => {
      throw new Error('listener failure')
    })
    const unsubscribeLater = subscribeHostLocale((locale) => updates.push(locale))
    try {
      expect(() => setHostLocale('it-IT')).not.toThrow()
      expect(updates).toEqual(['it'])
      expect(consoleError).toHaveBeenCalledWith('[Spindle] Host locale listener failed:', expect.any(Error))
    } finally {
      unsubscribeThrowing()
      unsubscribeLater()
      consoleError.mockRestore()
    }
  })
})
