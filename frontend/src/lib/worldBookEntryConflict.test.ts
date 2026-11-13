import { describe, expect, it } from 'bun:test'
import { ApiError } from '@/api/client'
import { classifyWorldBookEntryMutationError } from './worldBookEntryConflict'

describe('classifyWorldBookEntryMutationError', () => {
  it('classifies the canonical stale conflict payload', () => {
    const issue = classifyWorldBookEntryMutationError(new ApiError(409, 'Conflict', {
      error: 'world_book_entry_conflict',
      code: 'WORLD_BOOK_ENTRY_CONFLICT',
      conflicts: [{ id: 'entry-1', current: null }],
    }))
    expect(issue?.kind).toBe('conflict')
  })

  it('classifies structured malformed preconditions', () => {
    const issue = classifyWorldBookEntryMutationError(new ApiError(428, 'Precondition Required', {
      error: 'world_book_entry_precondition_invalid',
      code: 'WORLD_BOOK_ENTRY_PRECONDITION_INVALID',
      field: 'expected_revision',
      message: 'expected_revision must be a nonnegative safe integer',
    }))
    expect(issue?.kind).toBe('malformed-precondition')
  })

  it('does not classify unrelated errors or malformed bodies', () => {
    expect(classifyWorldBookEntryMutationError(new ApiError(409, 'Conflict', { error: 'other' }))).toBeNull()
    expect(classifyWorldBookEntryMutationError(new ApiError(500, 'Server Error', {}))).toBeNull()
  })
})
