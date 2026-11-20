import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const source = await Bun.file(join(import.meta.dir, 'WorldBookEntriesSection.tsx')).text()

describe('WorldBookEntriesSection P16 mutation totality', () => {
  const logicalPaths: Array<[string, RegExp]> = [
    ['immediate single update', /const updateEntry[\s\S]*persistEntryUpdate\(entryId, intent\)/],
    ['debounced single update', /const debouncedUpdateEntry[\s\S]*persistEntryUpdate\(entryId, intent\)/],
    ['single and multi-delete', /deleteEntry\([\s\S]*action: 'delete'[\s\S]*expected_revisions/],
    ['duplicate-here', /duplicateEntry\([\s\S]*expected_revision/],
    ['move and copy', /action: moveCopyState\.mode[\s\S]*expected_revisions/],
    ['bulk renumber', /action: 'renumber'[\s\S]*expected_revisions/],
    ['bulk add keyword', /action: 'add_keyword'[\s\S]*expected_revisions/],
    ['bulk set position', /action: 'set_position'[\s\S]*expected_revisions/],
    ['bulk set activation', /action: 'set_activation'[\s\S]*expected_revisions/],
    ['drag reorder', /reorderEntries\([\s\S]*expected_revisions/],
  ]

  for (const [name, pattern] of logicalPaths) {
    test(`${name} carries an optimistic concurrency expectation`, () => {
      expect(source).toMatch(pattern)
    })
  }

  test('all mutation families classify conflicts and expose explicit resolution', () => {
    expect(source).toContain('classifyWorldBookEntryMutationError')
    expect(source).toContain('recordMutationIssue')
    expect(source).toContain('retryConflict')
    expect(source).toContain('acceptServerConflict')
    expect(source).toContain('requestGenerationRef')
    expect(source).toContain('clearEntryTimers')
  })

  test('concurrent entry edits accumulate and renewed retries keep their handler', () => {
    expect(source.match(/updates: \{ \.\.\.previous\?\.updates, \.\.\.updates \}/g)).toHaveLength(2)
    expect(source).toContain('retryOperationsRef.current.get(id) === retry')
    expect(source).toContain('selectedBookIdRef.current !== bookId || requestGenerationRef.current !== generation')
    expect(source.match(/selectedBookId, generation\)/g)).toHaveLength(9)
  })
})
