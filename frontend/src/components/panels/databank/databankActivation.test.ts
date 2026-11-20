import { describe, expect, test } from 'bun:test'

import type { Databank } from '@/api/databank'
import {
  getContextDatabankBindings,
  isAutomaticallyActiveForContext,
} from './databankActivation'

function bank(
  id: string,
  scope: Databank['scope'],
  scopeId: string | null,
  enabled = true,
): Databank {
  return {
    id,
    userId: 'user-1',
    name: id,
    description: '',
    scope,
    scopeId,
    enabled,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('databank context activation display', () => {
  test('recognizes chat and character banks that activate automatically by scope', () => {
    expect(isAutomaticallyActiveForContext(bank('chat-bank', 'chat', 'chat-1'), 'chat', 'chat-1')).toBe(true)
    expect(isAutomaticallyActiveForContext(bank('chat-bank', 'chat', 'chat-2'), 'chat', 'chat-1')).toBe(false)
    expect(isAutomaticallyActiveForContext(bank('char-bank', 'character', 'char-1'), 'character', 'char-1')).toBe(true)
    expect(isAutomaticallyActiveForContext(bank('global-bank', 'global', null), 'character', 'char-1')).toBe(false)
  })

  test('merges automatic scope bindings with explicit attachments without duplicates', () => {
    const bindings = getContextDatabankBindings(
      [
        bank('automatic', 'chat', 'chat-1'),
        bank('attached', 'global', null),
        bank('both', 'chat', 'chat-1'),
        bank('unrelated', 'chat', 'chat-2'),
      ],
      'chat',
      'chat-1',
      ['attached', 'both'],
    )

    expect(bindings.map(({ bank: item, attached, automatic }) => ({
      id: item.id,
      attached,
      automatic,
    }))).toEqual([
      { id: 'automatic', attached: false, automatic: true },
      { id: 'attached', attached: true, automatic: false },
      { id: 'both', attached: true, automatic: true },
    ])
  })

  test('keeps disabled bindings visible for an accurate inactive-state explanation', () => {
    const [binding] = getContextDatabankBindings(
      [bank('disabled', 'character', 'char-1', false)],
      'character',
      'char-1',
      [],
    )

    expect(binding.bank.enabled).toBe(false)
    expect(binding.automatic).toBe(true)
  })
})
