const listeners = new Set<() => void>()

/** Published after shared imported data has been rehydrated into the store. */
export function publishImportedDataRefresh(): void {
  for (const listener of listeners) {
    try { listener() }
    catch (error) { console.error('[Import] Could not refresh a data view:', error) }
  }
}

export function subscribeImportedDataRefresh(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
