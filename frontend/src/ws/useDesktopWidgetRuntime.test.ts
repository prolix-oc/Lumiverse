import { describe, expect, test } from 'bun:test'
import { isTargetDesktopWidgetEvent } from './desktop-widget-event-isolation'

describe('desktop widget runtime event isolation', () => {
  test('accepts only events for the owning extension', () => {
    expect(isTargetDesktopWidgetEvent('subsonic', { extensionId: 'subsonic' })).toBe(true)
    expect(isTargetDesktopWidgetEvent('subsonic', { extensionId: 'chatroom' })).toBe(false)
    expect(isTargetDesktopWidgetEvent('subsonic', {})).toBe(false)
    expect(isTargetDesktopWidgetEvent('subsonic', null)).toBe(false)
  })
})
