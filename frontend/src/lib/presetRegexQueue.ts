let presetRegexQueue: Promise<void> = Promise.resolve()

export function enqueuePresetRegexOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = presetRegexQueue.catch(() => undefined).then(operation)
  presetRegexQueue = next.then(() => undefined, () => undefined)
  return next
}
