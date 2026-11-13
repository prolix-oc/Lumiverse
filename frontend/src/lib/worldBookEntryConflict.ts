import type {
  WorldBookEntryConflictPayload,
  WorldBookEntryPreconditionErrorPayload,
} from '@/types/api'
import { ApiError } from '@/api/client'

export type WorldBookEntryMutationIssue =
  | { kind: 'conflict'; payload: WorldBookEntryConflictPayload }
  | { kind: 'malformed-precondition'; payload: WorldBookEntryPreconditionErrorPayload }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isConflictPayload(value: unknown): value is WorldBookEntryConflictPayload {
  if (!isRecord(value) || value.error !== 'world_book_entry_conflict' || value.code !== 'WORLD_BOOK_ENTRY_CONFLICT') return false
  return Array.isArray(value.conflicts) && value.conflicts.every((item) => (
    isRecord(item) && typeof item.id === 'string' && (item.current === null || isRecord(item.current))
  ))
}

function isPreconditionPayload(value: unknown): value is WorldBookEntryPreconditionErrorPayload {
  return isRecord(value)
    && typeof value.error === 'string'
    && typeof value.code === 'string'
    && typeof value.field === 'string'
    && typeof value.message === 'string'
}

export function classifyWorldBookEntryMutationError(error: unknown): WorldBookEntryMutationIssue | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 409 && isConflictPayload(error.body)) return { kind: 'conflict', payload: error.body }
  if (error.status === 428 && isPreconditionPayload(error.body)) return { kind: 'malformed-precondition', payload: error.body }
  return null
}
