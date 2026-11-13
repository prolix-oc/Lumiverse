import { describe, expect, test } from 'bun:test'
import { resolveLandingChatPageSize } from './landingChatPagination'

describe('resolveLandingChatPageSize', () => {
  test('keeps the configured page size outside expanded card galleries', () => {
    expect(resolveLandingChatPageSize({
      configuredPageSize: 12,
      isExpanded: false,
      layout: 'cards',
      columns: 8,
      rowHeight: 260,
      availableHeight: 700,
    })).toBe(12)

    expect(resolveLandingChatPageSize({
      configuredPageSize: 12,
      isExpanded: true,
      layout: 'compact',
      columns: 4,
      rowHeight: 86,
      availableHeight: 700,
    })).toBe(12)
  })

  test('fills the expanded grid with enough cards for its visible rows', () => {
    expect(resolveLandingChatPageSize({
      configuredPageSize: 12,
      isExpanded: true,
      layout: 'cards',
      columns: 8,
      rowHeight: 260,
      availableHeight: 700,
    })).toBe(32)
  })

  test('does not let the configured batch size override expanded cards', () => {
    expect(resolveLandingChatPageSize({
      configuredPageSize: 100,
      isExpanded: true,
      layout: 'cards',
      columns: 8,
      rowHeight: 260,
      availableHeight: 700,
    })).toBe(32)
  })

  test('uses a three-row expanded fallback before the viewport is measured', () => {
    expect(resolveLandingChatPageSize({
      configuredPageSize: 12,
      isExpanded: true,
      layout: 'cards',
      columns: 6,
      rowHeight: 260,
      availableHeight: 0,
    })).toBe(18)
  })
})
