export async function refreshLorebookIfCurrent(
  bookId: string,
  getCurrentBookId: () => string | null,
  refresh: () => Promise<void>,
): Promise<boolean> {
  if (getCurrentBookId() !== bookId) return false
  await refresh()
  return getCurrentBookId() === bookId
}

export async function runLorebookReorderIfCurrent({
  bookId,
  getCurrentBookId,
  reorder,
  refresh,
  onSaved,
}: {
  bookId: string
  getCurrentBookId: () => string | null
  reorder: () => Promise<void>
  refresh: () => Promise<void>
  onSaved: () => void
}): Promise<boolean> {
  await reorder()
  const refreshed = await refreshLorebookIfCurrent(bookId, getCurrentBookId, refresh)
  if (!refreshed) return false
  onSaved()
  return true
}
