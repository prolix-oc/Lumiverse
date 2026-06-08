import type { PaginatedResult } from '@/types/api'

const CONNECTIONS_PAGE = 200

/**
 * Page a connection list to exhaustion. The store-fed connection selectors
 * (`ConnectionSelect`, `VoicePicker`, …) treat the store list as the complete
 * set, so ANY caller that writes the store must load every page — a single
 * `list({ limit: 100 })` silently re-caps it and drops connections 101+ for the
 * rest of the session. Mirrors the bootstrap service's `collectAll`; driven by
 * the reported `total`, so it's correct regardless of server-side page clamping.
 */
export async function listAllConnections<T>(
  api: { list: (params: { limit: number; offset: number }) => Promise<PaginatedResult<T>> },
): Promise<PaginatedResult<T>> {
  const data: T[] = []
  let offset = 0
  for (;;) {
    const page = await api.list({ limit: CONNECTIONS_PAGE, offset })
    data.push(...page.data)
    offset += page.data.length
    if (page.data.length === 0 || offset >= page.total) break
  }
  return { data, total: data.length, limit: data.length, offset: 0 }
}