/** Load the complete filtered scope before relevance ranking and pagination. */
export async function loadLorebookSearchEntries<T>(
  fetchPage: (pagination: { limit: number; offset: number }) => Promise<{ data: T[]; total: number }>,
  signal: AbortSignal,
): Promise<T[]> {
  const entries: T[] = []
  let total = Number.POSITIVE_INFINITY
  while (entries.length < total) {
    signal.throwIfAborted()
    const page = await fetchPage({ limit: 1000, offset: entries.length })
    signal.throwIfAborted()
    total = page.total
    if (page.data.length === 0 && entries.length < total) {
      throw new Error('Incomplete lorebook search source. Retry Refresh.')
    }
    entries.push(...page.data)
  }
  return entries
}
