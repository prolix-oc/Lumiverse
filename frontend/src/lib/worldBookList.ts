export function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  let replaced = false
  const next: T[] = []

  for (const current of items) {
    if (current.id === item.id) {
      if (!replaced) {
        next.push(item)
        replaced = true
      }
      continue
    }
    next.push(current)
  }

  if (!replaced) {
    next.unshift(item)
  }

  return next
}
