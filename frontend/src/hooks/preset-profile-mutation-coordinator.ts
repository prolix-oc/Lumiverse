export interface PresetProfileFetchToken {
  fetchRevision: number
}

export interface PresetProfileMutationCoordinator {
  beginFetch(scope: string): PresetProfileFetchToken
  currentFetch(scope: string): PresetProfileFetchToken
  beginMutation(scope: string): number
  enqueue<T>(scope: string, operation: () => Promise<T>, canStart?: () => boolean): Promise<T>
  invalidateFetch(scope: string): void
  invalidateMutations(): void
  mutationEpoch(scope: string): number
  isMutationEpochCurrent(scope: string, epoch: number): boolean
  isFetchCurrent(scope: string, token: PresetProfileFetchToken): boolean
  isMutationCurrent(scope: string, revision: number): boolean
}

export type PresetProfileMutationResult = 'committed' | 'stale' | 'failed'

export interface RunPresetProfileMutationOptions<TWrite, TRecovery> {
  coordinator: PresetProfileMutationCoordinator
  scope: string
  operation: () => Promise<TWrite>
  canStart?: () => boolean
  refresh: () => Promise<TRecovery>
  isCurrent: (revision: number) => boolean
  commit: (value: TWrite) => void
  recover: (value: TRecovery) => void
}

function bumpRevision(revisions: Map<string, number>, scope: string): number {
  const revision = (revisions.get(scope) ?? 0) + 1
  revisions.set(scope, revision)
  return revision
}

function getRevision(revisions: Map<string, number>, scope: string): number {
  return revisions.get(scope) ?? 0
}

export function createPresetProfileMutationCoordinator(): PresetProfileMutationCoordinator {
  const mutationRevisions = new Map<string, number>()
  const mutationEpochs = new Map<string, number>()
  const fetchRevisions = new Map<string, number>()
  const queues = new Map<string, Promise<unknown>>()

  const beginFetch = (scope: string): PresetProfileFetchToken => ({
    fetchRevision: bumpRevision(fetchRevisions, scope),
  })

  const currentFetch = (scope: string): PresetProfileFetchToken => ({
    fetchRevision: getRevision(fetchRevisions, scope),
  })

  // Starting a mutation does not invalidate an existing GET. If the write
  // fails, recovery starts a fresh fetch revision after the operation; a
  // successful write invalidates fetches before committing its response.
  // Keeping the initial GET alive until the outcome is known avoids losing
  // the last authoritative recovery path.
  const beginMutation = (scope: string): number => bumpRevision(mutationRevisions, scope)

  const enqueue = <T,>(
    scope: string,
    operation: () => Promise<T>,
    canStart?: () => boolean,
  ): Promise<T> => {
    const previous = queues.get(scope) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => {
      if (canStart && !canStart()) throw new Error('STALE_PRESET_PROFILE_MUTATION')
      return operation()
    })
    queues.set(scope, next)
    const cleanup = () => {
      if (queues.get(scope) === next) queues.delete(scope)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  return {
    beginFetch,
    currentFetch,
    beginMutation,
    enqueue,
    invalidateFetch: (scope) => { bumpRevision(fetchRevisions, scope) },
    invalidateMutations: () => {
      for (const scope of new Set([
        ...mutationRevisions.keys(),
        ...mutationEpochs.keys(),
        ...fetchRevisions.keys(),
        ...queues.keys(),
      ])) {
        bumpRevision(mutationRevisions, scope)
        bumpRevision(mutationEpochs, scope)
        bumpRevision(fetchRevisions, scope)
      }
    },
    mutationEpoch: (scope) => getRevision(mutationEpochs, scope),
    isMutationEpochCurrent: (scope, epoch) => getRevision(mutationEpochs, scope) === epoch,
    isFetchCurrent: (scope, token) => getRevision(fetchRevisions, scope) === token.fetchRevision,
    isMutationCurrent: (scope, revision) => getRevision(mutationRevisions, scope) === revision,
  }
}

export async function runPresetProfileMutation<TWrite, TRecovery>({
  coordinator,
  scope,
  operation,
  canStart,
  refresh,
  isCurrent,
  commit,
  recover,
}: RunPresetProfileMutationOptions<TWrite, TRecovery>): Promise<PresetProfileMutationResult> {
  const revision = coordinator.beginMutation(scope)
  const mutationEpoch = coordinator.mutationEpoch(scope)
  try {
    const value = await coordinator.enqueue(
      scope,
      operation,
      () => coordinator.isMutationEpochCurrent(scope, mutationEpoch) && (canStart?.() ?? true),
    )
    coordinator.invalidateFetch(scope)
    if (!isCurrent(revision)) return 'stale'
    commit(value)
    return 'committed'
  } catch {
    if (!isCurrent(revision)) return 'stale'
    const fetchToken = coordinator.beginFetch(scope)
    try {
      const value = await refresh()
      if (isCurrent(revision) && coordinator.isFetchCurrent(scope, fetchToken)) recover(value)
    } catch {
      // Preserve the last visible state when recovery itself fails. The
      // mutation error still returns to the caller for user-facing feedback.
    }
    return isCurrent(revision) ? 'failed' : 'stale'
  }
}
