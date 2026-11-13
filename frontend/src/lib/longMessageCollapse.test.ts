/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import type { UISlice } from '@/types/store'
import { createUISlice } from '@/store/slices/ui'
import {
  getLongMessageCollapseHeight,
  isLongMessageCollapseEligible,
  isLongMessageOverflowing,
  longMessageExpansionKey,
} from './longMessageCollapse'

describe('long message collapse policy', () => {
  test('maps fixed presets and resolves a clamped custom pixel height', () => {
    expect(getLongMessageCollapseHeight('compact')).toBe(300)
    expect(getLongMessageCollapseHeight('comfortable')).toBe(500)
    expect(getLongMessageCollapseHeight('tall')).toBe(800)
    expect(getLongMessageCollapseHeight('custom', 347)).toBe(347)
    expect(getLongMessageCollapseHeight('custom', 10)).toBe(100)
    expect(getLongMessageCollapseHeight('custom', 99999)).toBe(4000)
  })

  test('only enables collapsing for identified assistant chat messages', () => {
    expect(isLongMessageCollapseEligible({
      enabled: true,
      isUser: false,
      chatId: 'chat-1',
      messageId: 'message-1',
    })).toBe(true)
    expect(isLongMessageCollapseEligible({
      enabled: true,
      isUser: true,
      chatId: 'chat-1',
      messageId: 'message-1',
    })).toBe(false)
    expect(isLongMessageCollapseEligible({ enabled: true, isUser: false })).toBe(false)
    expect(isLongMessageCollapseEligible({
      enabled: false,
      isUser: false,
      chatId: 'chat-1',
      messageId: 'message-1',
    })).toBe(false)
  })

  test('requires content to exceed the limit beyond layout rounding noise', () => {
    expect(isLongMessageOverflowing(500, 500)).toBe(false)
    expect(isLongMessageOverflowing(501, 500)).toBe(false)
    expect(isLongMessageOverflowing(502, 500)).toBe(true)
  })
})

describe('long message expansion session state', () => {
  test('keeps expansion keyed by both chat and message', () => {
    const store = createStore<UISlice>()(createUISlice)
    const firstKey = longMessageExpansionKey('chat-1', 'message-1')
    const secondKey = longMessageExpansionKey('chat-2', 'message-1')

    store.getState().setLongMessageExpanded('chat-1', 'message-1', true)
    store.getState().setLongMessageExpanded('chat-2', 'message-1', true)
    expect(store.getState().expandedLongMessageKeys).toEqual([firstKey, secondKey])

    store.getState().setLongMessageExpanded('chat-1', 'message-1', true)
    expect(store.getState().expandedLongMessageKeys).toEqual([firstKey, secondKey])

    store.getState().setLongMessageExpanded('chat-1', 'message-1', false)
    expect(store.getState().expandedLongMessageKeys).toEqual([secondKey])
  })
})
