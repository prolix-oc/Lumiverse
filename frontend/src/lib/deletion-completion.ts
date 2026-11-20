import { onDeletionOperation, onDeletionReconnect, type DeletionOperation } from './deletion-events'

export class DeletionUnconfirmedError extends Error {
  constructor(readonly operationId: string) {
    super('Deletion is still unconfirmed. Refresh to check its status.')
    this.name = 'DeletionUnconfirmedError'
  }
}

/** Subscribe before requesting; poll durable status when responses/events are lost. */
export function completeDeletion(options: {
  operationId: string
  entityId: string
  request: (signal: AbortSignal) => Promise<DeletionOperation>
  readStatus: (signal: AbortSignal) => Promise<DeletionOperation | null>
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
}): Promise<DeletionOperation> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let checking = false
    let poll: ReturnType<typeof setTimeout> | undefined
    const finish = (operation?: DeletionOperation, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(poll)
      unsubscribe()
      disconnect()
      options.signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (operation) resolve(operation)
      else reject(error)
    }
    const observe = (operation: DeletionOperation | null) => {
      if (!operation || operation.operationId !== options.operationId || operation.entity !== 'character' || operation.entityId !== options.entityId) return
      if (operation.status === 'completed') finish(operation)
      else if (operation.status === 'failed') finish(undefined, Object.assign(new Error(operation.error?.message || 'Deletion failed'), { operationId: operation.operationId }))
    }
    const check = async () => {
      if (settled || checking) return
      checking = true
      clearTimeout(poll)
      try { observe(await options.readStatus(controller.signal)) }
      catch (error: any) {
        if (error?.name === 'InactiveTabError' || error?.status === 401 || error?.status === 403) finish(undefined, error)
      } finally {
        checking = false
        if (!settled) poll = setTimeout(check, options.pollMs ?? 1000)
      }
    }
    const unsubscribe = onDeletionOperation(observe)
    const disconnect = onDeletionReconnect(() => { void check() })
    const deadline = setTimeout(() => finish(undefined, new DeletionUnconfirmedError(options.operationId)), options.timeoutMs ?? 5 * 60_000)
    const onAbort = () => finish(undefined, options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) { onAbort(); return }
    void options.request(controller.signal).then(observe).catch((error: any) => {
      if (error?.status >= 400 && error?.status < 500 && error?.status !== 408 && error?.status !== 429) finish(undefined, error)
      else if (error?.name === 'InactiveTabError') finish(undefined, error)
    }).finally(() => { void check() })
    poll = setTimeout(check, options.pollMs ?? 1000)
  })
}
