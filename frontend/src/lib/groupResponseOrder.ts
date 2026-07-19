export type GroupResponseOrder = 'sequential' | 'random'

export function readGroupResponseOrder(metadata: Record<string, any> | null | undefined): GroupResponseOrder {
  return metadata?.group_response_order === 'random' ? 'random' : 'sequential'
}

export function orderGroupResponseIds(
  ids: string[],
  mode: GroupResponseOrder,
  opts: {
    priorityIds?: string[]
    random?: () => number
  } = {},
): string[] {
  const seen = new Set<string>()
  const uniqueIds = ids.filter((id) => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })

  const priorityIds = (opts.priorityIds || []).filter((id) => uniqueIds.includes(id))
  if (priorityIds.length > 0) {
    const priority = Array.from(new Set(priorityIds))
    const rest = uniqueIds.filter((id) => !priority.includes(id))
    return [...priority, ...orderGroupResponseIds(rest, mode, { random: opts.random })]
  }

  if (mode !== 'random' || uniqueIds.length < 2) return uniqueIds

  const random = opts.random || Math.random
  const shuffled = [...uniqueIds]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}
