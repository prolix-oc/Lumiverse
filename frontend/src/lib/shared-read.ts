/** Only pending reads are shared. A settled value is never a freshness cache. */
let scope = 0
let accountEpoch = 0
const pending = new Map<string, Promise<unknown>>()
export const sharedReadScope = () => scope
export const readAccountEpoch = () => accountEpoch
export function resetAccountReads(): void {
  accountEpoch += 1
  invalidateSharedReads()
}

export function invalidateSharedReads(): void {
  scope += 1
  pending.clear()
}

export function shareRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const scopedKey = `${scope}:${key}`
  let request = pending.get(scopedKey) as Promise<T> | undefined
  if (!request) {
    request = Promise.resolve().then(read)
    pending.set(scopedKey, request)
    const release = () => {
      if (pending.get(scopedKey) === request) pending.delete(scopedKey)
    }
    void request.then(release, release)
  }
  // Independent consumers may unmarshal or edit their own copy.
  return request.then(value => structuredClone(value))
}
