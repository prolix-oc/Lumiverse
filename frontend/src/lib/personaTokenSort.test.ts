import { describe, expect, test } from 'bun:test'
import type { Persona } from '@/types/api'

import {
  approximateTokenCount,
  buildApproximatePersonaTokenCounts,
  comparePersonasByTokenCount,
  PersonaTokenCountRequestGuard,
} from './personaTokenSort'

function persona(id: string, name: string, description: string): Persona {
  return {
    id,
    name,
    title: '',
    description,
    subjective_pronoun: '',
    objective_pronoun: '',
    possessive_pronoun: '',
    avatar_path: null,
    image_id: null,
    attached_world_book_id: null,
    folder: '',
    is_default: false,
    is_narrator: false,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  }
}

describe('persona token sorting', () => {
  test('builds Count Tokens-compatible approximations including empty descriptions', () => {
    const personas = [persona('empty', 'Empty', ''), persona('filled', 'Filled', '12345')]

    expect(approximateTokenCount('')).toBe(0)
    expect(buildApproximatePersonaTokenCounts(personas)).toEqual({ empty: 0, filled: 2 })
  })

  test('sorts in both directions and uses stable name/id tie-breakers', () => {
    const personas = [
      persona('b', 'Same', ''),
      persona('a', 'Same', ''),
      persona('long', 'Long', ''),
    ]
    const counts = { a: 1, b: 1, long: 5 }

    expect([...personas].sort((a, b) => comparePersonasByTokenCount(a, b, counts, 'asc')).map((p) => p.id))
      .toEqual(['a', 'b', 'long'])
    expect([...personas].sort((a, b) => comparePersonasByTokenCount(a, b, counts, 'desc')).map((p) => p.id))
      .toEqual(['long', 'a', 'b'])
  })

  test('retains approximate counts when an exact response omits a changed persona', () => {
    const old = persona('old', 'Old', '1234')
    const changed = persona('changed', 'Changed', 'x'.repeat(20))

    expect([changed, old].sort((a, b) => comparePersonasByTokenCount(a, b, { old: 1 }, 'asc')).map((p) => p.id))
      .toEqual(['old', 'changed'])
  })
})

describe('PersonaTokenCountRequestGuard', () => {
  test('rejects stale responses after model or persona data changes', () => {
    const guard = new PersonaTokenCountRequestGuard()
    const firstModelRequest = guard.begin()
    const secondModelRequest = guard.begin()

    expect(guard.isCurrent(firstModelRequest)).toBe(false)
    expect(guard.isCurrent(secondModelRequest)).toBe(true)

    guard.invalidate()
    expect(guard.isCurrent(secondModelRequest)).toBe(false)
  })
})
