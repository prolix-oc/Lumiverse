import { describe, expect, mock, test } from 'bun:test'
import { completeDeletion, DeletionUnconfirmedError } from './deletion-completion'
import { notifyDeletionOperation, notifyDeletionReconnect, notifyImageDeleted, onImageDeleted, type DeletionOperation } from './deletion-events'

function operation(status: DeletionOperation['status'], id = crypto.randomUUID()): DeletionOperation {
  return { operationId: id, entity: 'character', entityId: 'character', status, createdAt: 1, updatedAt: 2 }
}

describe('deletion confirmation', () => {
  test('acceptance does not resolve and completion may arrive before the HTTP response', async () => {
    const accepted = operation('accepted')
    const response = Promise.withResolvers<DeletionOperation>()
    const readStatus = mock(async () => accepted)
    let resolved = false
    const pending = completeDeletion({ operationId: accepted.operationId, entityId: 'character', request: () => response.promise, readStatus }).then((value) => { resolved = true; return value })
    notifyDeletionOperation(accepted)
    notifyDeletionOperation(operation('completed')) // Unrelated operation.
    await Promise.resolve()
    expect(resolved).toBe(false)
    notifyDeletionOperation({ ...accepted, status: 'completed' })
    expect((await pending).status).toBe('completed')
    response.resolve(accepted)
  })

  test('a lost response is reconciled by status without repeating the request', async () => {
    const completed = operation('completed')
    const request = mock(async () => { throw new Error('connection lost') })
    const readStatus = mock(async () => completed)
    await expect(completeDeletion({ operationId: completed.operationId, entityId: 'character', request, readStatus })).resolves.toEqual(completed)
    expect(request).toHaveBeenCalledTimes(1)
    expect(readStatus).toHaveBeenCalledTimes(1)
  })

  test('a reconnect immediately checks persisted status when the completion event was missed', async () => {
    const accepted = operation('accepted')
    let state = accepted
    const firstCheck = Promise.withResolvers<void>()
    const pending = completeDeletion({ operationId: accepted.operationId, entityId: 'character', pollMs: 60_000,
      request: async () => accepted, readStatus: async () => { firstCheck.resolve(); return state } })
    await firstCheck.promise
    await Promise.resolve()
    state = { ...accepted, status: 'completed' }
    notifyDeletionReconnect()
    expect((await pending).status).toBe('completed')
  })

  test('failure rejects and an uncertain timeout never reports completion', async () => {
    const failed = operation('failed')
    await expect(completeDeletion({ operationId: failed.operationId, entityId: 'character', request: async () => failed, readStatus: async () => failed })).rejects.toThrow('Deletion failed')
    const unknown = operation('unknown')
    await expect(completeDeletion({ operationId: unknown.operationId, entityId: 'character', timeoutMs: 20, pollMs: 2, request: async () => unknown, readStatus: async () => unknown })).rejects.toBeInstanceOf(DeletionUnconfirmedError)
  })

  test('cancellation aborts pending status reads and unsubscribes', async () => {
    const accepted = operation('accepted')
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const pending = completeDeletion({ operationId: accepted.operationId, entityId: 'character', signal: controller.signal,
      request: async (signal) => { requestSignal = signal; return accepted }, readStatus: async () => accepted })
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(requestSignal?.aborted).toBe(true)
    notifyDeletionOperation({ ...accepted, status: 'completed' })
  })

  test('HTTP and repeated WebSocket image confirmations notify listeners once', () => {
    const listener = mock(() => {})
    const stop = onImageDeleted(listener)
    try {
      const id = crypto.randomUUID()
      notifyImageDeleted(id)
      notifyImageDeleted(id)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally { stop() }
  })
})
