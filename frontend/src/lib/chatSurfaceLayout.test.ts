import { describe, expect, test } from 'bun:test'
import {
  chatLoreDockMode,
  chatTopDockMode,
  composeChatSafeZones,
  dockActionControlSize,
} from './chatSurfaceLayout'

describe('chat surface dock modes', () => {
  test('accepts the literal top dock modes', () => {
    expect(chatTopDockMode('strip')).toBe('strip')
    expect(chatTopDockMode('floating')).toBe('floating')
  })

  test('accepts only literal lore dock modes', () => {
    expect(chatLoreDockMode('hidden')).toBe('hidden')
    expect(chatLoreDockMode('floating')).toBe('floating')
    expect(chatLoreDockMode('strip')).toBe('strip')
  })

  test('uses conservative fallbacks for unknown, zero, and nonfinite requests', () => {
    expect(chatTopDockMode('unknown')).toBe('floating')
    expect(chatTopDockMode(0)).toBe('floating')
    expect(chatTopDockMode(Number.NaN)).toBe('floating')

    expect(chatLoreDockMode('unknown')).toBe('hidden')
    expect(chatLoreDockMode(0)).toBe('hidden')
    expect(chatLoreDockMode(Number.NaN)).toBe('hidden')
  })
})

describe('chat surface control sizing', () => {
  test('adds compact or default density padding to a valid icon size', () => {
    expect(dockActionControlSize(24, 'compact')).toBe(32)
    expect(dockActionControlSize(24, 'default')).toBe(44)
  })

  test('falls back to the default icon size and treats zero as valid', () => {
    expect(dockActionControlSize(undefined, 'compact')).toBe(24)
    expect(dockActionControlSize(Number.NaN, 'default')).toBe(36)
    expect(dockActionControlSize(-1, 'default')).toBe(36)
    expect(dockActionControlSize(0, 'compact')).toBe(8)
  })
})

describe('chat surface safe zones', () => {
  test('folds composer, lore, and bottom occupied heights in order', () => {
    expect(composeChatSafeZones(100, 48, 16)).toEqual({
      composerSafeZone: 116,
      inputSafeZone: 164,
    })
  })

  test('sanitizes negative and nonfinite heights to zero', () => {
    expect(composeChatSafeZones(-20, Number.POSITIVE_INFINITY, Number.NaN)).toEqual({
      composerSafeZone: 0,
      inputSafeZone: 0,
    })
    expect(composeChatSafeZones(Number.NEGATIVE_INFINITY, -12, 8)).toEqual({
      composerSafeZone: 8,
      inputSafeZone: 8,
    })
  })
})
