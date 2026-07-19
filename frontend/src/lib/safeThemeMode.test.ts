import { describe, expect, it } from 'bun:test'

import { hasSafeThemeQuery, resolveSafeThemeState } from './safeThemeMode'

describe('safe theme mode', () => {
  it('accepts explicit and valueless safe-theme recovery queries', () => {
    expect(hasSafeThemeQuery('?safe-theme=1')).toBe(true)
    expect(hasSafeThemeQuery('?safe-theme=true')).toBe(true)
    expect(hasSafeThemeQuery('?safe-theme')).toBe(true)
    expect(hasSafeThemeQuery('?other=value&safe-theme=on')).toBe(true)
  })

  it('allows explicit false query values without enabling recovery mode', () => {
    expect(hasSafeThemeQuery('?safe-theme=0')).toBe(false)
    expect(hasSafeThemeQuery('?safe-theme=false')).toBe(false)
    expect(hasSafeThemeQuery('?safe-theme=off')).toBe(false)
    expect(hasSafeThemeQuery('?other=value')).toBe(false)
  })

  it('reports whether recovery came from the URL, server, or both', () => {
    expect(resolveSafeThemeState('', false)).toEqual({ active: false, source: null })
    expect(resolveSafeThemeState('?safe-theme=1', false)).toEqual({ active: true, source: 'url' })
    expect(resolveSafeThemeState('', true)).toEqual({ active: true, source: 'server' })
    expect(resolveSafeThemeState('?safe-theme=1', true)).toEqual({ active: true, source: 'both' })
  })
})
