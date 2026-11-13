import { describe, expect, test } from 'bun:test'

import { upsertById } from './worldBookList'

describe('upsertById', () => {
  test('prepends a missing item', () => {
    expect(
      upsertById(
        [{ id: 'b', name: 'Existing B' }, { id: 'c', name: 'Existing C' }],
        { id: 'a', name: 'New A' },
      ),
    ).toEqual([
      { id: 'a', name: 'New A' },
      { id: 'b', name: 'Existing B' },
      { id: 'c', name: 'Existing C' },
    ])
  })

  test('replaces an existing item in place', () => {
    expect(
      upsertById(
        [{ id: 'a', name: 'Old A' }, { id: 'b', name: 'Existing B' }],
        { id: 'a', name: 'New A' },
      ),
    ).toEqual([
      { id: 'a', name: 'New A' },
      { id: 'b', name: 'Existing B' },
    ])
  })

  test('collapses duplicate ids down to one item', () => {
    expect(
      upsertById(
        [{ id: 'a', name: 'First A' }, { id: 'b', name: 'Existing B' }, { id: 'a', name: 'Second A' }],
        { id: 'a', name: 'Merged A' },
      ),
    ).toEqual([
      { id: 'a', name: 'Merged A' },
      { id: 'b', name: 'Existing B' },
    ])
  })
})
