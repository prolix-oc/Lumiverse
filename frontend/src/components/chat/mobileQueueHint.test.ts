/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { getMobileQueueHintKey } from './mobileQueueHint'

describe('getMobileQueueHintKey', () => {
  test('does not show a persistent idle hint on touch devices', () => {
    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: true,
      isGeneratingInChat: false,
      mobileQueueHoldState: 'idle',
    })).toBeNull()
  })

  test('shows the active hold state hints', () => {
    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: true,
      isGeneratingInChat: false,
      mobileQueueHoldState: 'holding',
    })).toBe('input.keepHoldingToQueue')

    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: true,
      isGeneratingInChat: false,
      mobileQueueHoldState: 'armed',
    })).toBe('input.releaseToQueue')

    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: true,
      isGeneratingInChat: false,
      mobileQueueHoldState: 'queueing',
    })).toBe('input.queueingMessage')
  })

  test('suppresses the hint when touch queueing is unavailable or generation is active', () => {
    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: false,
      isGeneratingInChat: false,
      mobileQueueHoldState: 'holding',
    })).toBeNull()

    expect(getMobileQueueHintKey({
      supportsTouchQueueHold: true,
      isGeneratingInChat: true,
      mobileQueueHoldState: 'holding',
    })).toBeNull()
  })
})
