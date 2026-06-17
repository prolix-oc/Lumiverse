import type { PaginatedResult } from '@/types/api'

const CONNECTIONS_PAGE = 200

/**
 * Page a connection list to exhaustion. Consumers treat the store list as
 * complete, so any caller that writes the store must load every page.
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
