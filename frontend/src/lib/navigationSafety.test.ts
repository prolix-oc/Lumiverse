import { describe, expect, test } from 'bun:test'
import { getSafeInAppNavigationUrl, isSafeWindowOpenTarget } from './navigationSafety'

describe('isSafeWindowOpenTarget', () => {
  test('allows only the inert about:blank popup placeholder among non-web schemes', () => {
    expect(isSafeWindowOpenTarget('about:blank')).toBe(true)
    expect(isSafeWindowOpenTarget('about:srcdoc')).toBe(false)
    expect(isSafeWindowOpenTarget('javascript:alert(1)')).toBe(false)
  })
})

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
