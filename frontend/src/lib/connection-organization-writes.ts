import { post } from '@/api/client'
import { applyOrganizationEdits, type OrganizationEdit } from '../../../src/shared/connection-organization-edits'

type Values = Record<string, unknown>
/** One queue per store session, shared by all kinds. Nothing is stored in browser storage. */
export function createOrganizationWriter(dependencies: {
  write?: (edits: OrganizationEdit[]) => Promise<Values>
  commit(values: Values): void
  failed(error: unknown): void | Values | Promise<void | Values>
  settled?(): void
}) {
  const queue: OrganizationEdit[][] = []
  let running = false, disposed = false
  let completion: Promise<void> = Promise.resolve()
  return {
    get pending() { return running },
    flush() { return completion },
    enqueue(edits: OrganizationEdit[]) {
      if (!edits.length || disposed) return
      queue.push(edits)
      if (running) return
      running = true
      completion = (async () => {
        try {
          while (queue.length && !disposed) {
            try {
              const values = await (dependencies.write ?? (input => post<Values>('/connections/organization/edit', input)))(queue[0])
              if (disposed) return
              queue.shift()
              // Preserve edits made while the request was in flight.
              dependencies.commit(applyOrganizationEdits(values, queue.flat()))
            } catch (error) {
              queue.length = 0
              if (disposed) return
              const recovered = await dependencies.failed(error)
              if (!disposed && recovered) dependencies.commit(applyOrganizationEdits(recovered, queue.flat()))
              // Edits queued during recovery are handled by the next iteration.
            }
          }
        } catch (error) {
          queue.length = 0
          if (!disposed) console.error('[connection-organization] Recovery failed', error)
        } finally { running = false; if (!disposed) dependencies.settled?.() }
      })()
    },
    dispose() { disposed = true; queue.length = 0 },
  }
}
