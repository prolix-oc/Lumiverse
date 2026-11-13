import { describe, expect, test } from 'bun:test'

import { clearSearchOnEscape } from './clearableSearch'

describe('clearSearchOnEscape', () => {
  test('clears and consumes Escape when the search has a value', () => {
    const calls: string[] = []
    const handled = clearSearchOnEscape({
      key: 'Escape',
      preventDefault: () => calls.push('prevent'),
      stopPropagation: () => calls.push('stop'),
    }, 'query', () => calls.push('clear'))

    expect(handled).toBe(true)
    expect(calls).toEqual(['prevent', 'stop', 'clear'])
  })

  test('does not consume Escape for an already empty search', () => {
    const handled = clearSearchOnEscape({
      key: 'Escape',
      preventDefault: () => { throw new Error('unexpected preventDefault') },
      stopPropagation: () => { throw new Error('unexpected stopPropagation') },
    }, '', () => { throw new Error('unexpected clear') })

    expect(handled).toBe(false)
  })
})
