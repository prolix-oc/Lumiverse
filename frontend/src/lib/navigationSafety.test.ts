import { describe, expect, test } from 'bun:test'
import { getSafeInAppNavigationUrl } from './navigationSafety'

describe('getSafeInAppNavigationUrl', () => {
  test('keeps browser-router paths used by extension push notifications', () => {
    expect(getSafeInAppNavigationUrl('/chat/chat-123')).toBe('/chat/chat-123')
  })

  test('normalizes legacy hash-router notification links', () => {
    expect(getSafeInAppNavigationUrl('/#/chat/chat-123')).toBe('/chat/chat-123')
  })

  test('rejects external targets', () => {
    expect(getSafeInAppNavigationUrl('https://example.com/chat/chat-123')).toBe('/')
    expect(getSafeInAppNavigationUrl('//example.com/chat/chat-123')).toBe('/')
  })
})
