import { describe, expect, test } from 'bun:test'
import { createPresetProfileMutationCoordinator, runPresetProfileMutation } from './preset-profile-mutation-coordinator'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

describe('preset profile mutation coordinator', () => {
  test('serializes same-target bind and unbind operations in invocation order', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const firstGate = deferred<void>()
    const calls: string[] = []

    const first = coordinator.enqueue('chat-binding:chat-a', async () => {
      calls.push('bind-start')
      await firstGate.promise
      calls.push('bind-end')
      return 'bound'
    })
    const second = coordinator.enqueue('chat-binding:chat-a', async () => {
      calls.push('unbind')
      return 'unbound'
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['bind-start'])
    firstGate.resolve()

    expect(await first).toBe('bound')
    expect(await second).toBe('unbound')
    expect(calls).toEqual(['bind-start', 'bind-end', 'unbind'])
  })

  test('a successful mutation invalidates an in-flight GET while failed writes leave it recoverable', () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'

    const initialFetch = coordinator.beginFetch(scope)
    const mutation = coordinator.beginMutation(scope)
    expect(coordinator.isMutationCurrent(scope, mutation)).toBe(true)
    expect(coordinator.isFetchCurrent(scope, initialFetch)).toBe(true)

    coordinator.invalidateFetch(scope)
    expect(coordinator.isFetchCurrent(scope, initialFetch)).toBe(false)

    const retryFetch = coordinator.beginFetch(scope)
    const failedMutation = coordinator.beginMutation(scope)
    expect(coordinator.isFetchCurrent(scope, retryFetch)).toBe(true)
    expect(coordinator.isMutationCurrent(scope, failedMutation)).toBe(true)
  })

  test('failed latest mutations leave the original GET token available for recovery', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const fetchToken = coordinator.beginFetch(scope)
    coordinator.beginMutation(scope)
    const failure = coordinator.enqueue(scope, async () => {
      throw new Error('write failed')
    })

    await expect(failure).rejects.toThrow('write failed')
    expect(coordinator.isFetchCurrent(scope, fetchToken)).toBe(true)
  })

  test('older mutations cannot commit after a newer same-target mutation starts', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const firstGate = deferred<void>()
    const firstRevision = coordinator.beginMutation(scope)
    const first = coordinator.enqueue(scope, async () => {
      await firstGate.promise
    })
    const secondRevision = coordinator.beginMutation(scope)
    const second = coordinator.enqueue(scope, async () => {})

    expect(coordinator.isMutationCurrent(scope, firstRevision)).toBe(false)
    expect(coordinator.isMutationCurrent(scope, secondRevision)).toBe(true)
    firstGate.resolve()
    await Promise.all([first, second])
  })

  test('recovers an earlier successful bind when a queued unbind fails', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const bindGate = deferred<void>()
    const binding = { preset_id: 'preset-bound', block_states: {}, captured_at: 1 }
    let persisted = { preset_id: 'preset-old', block_states: {}, captured_at: 0 }
    let visible = persisted

    const bind = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => {
        await bindGate.promise
        persisted = binding
        return binding
      },
      refresh: async () => persisted,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: (value) => { visible = value },
      recover: (value) => { visible = value },
    })
    const unbind = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => { throw new Error('unbind failed') },
      refresh: async () => persisted,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: () => { persisted = { preset_id: 'preset-old', block_states: {}, captured_at: 0 } },
      recover: (value) => { visible = value },
    })

    bindGate.resolve()
    expect(await bind).toBe('stale')
    expect(await unbind).toBe('failed')
    expect(persisted).toBe(binding)
    expect(visible).toBe(binding)
  })

  test('recovers an absent binding after a queued duplicate delete', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const deleteGate = deferred<void>()
    const binding = { preset_id: 'preset-bound', block_states: {}, captured_at: 1 }
    let persisted: typeof binding | null = binding
    let visible: typeof binding | null = binding

    const firstDelete = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => {
        await deleteGate.promise
        persisted = null
      },
      refresh: async () => persisted,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: () => { visible = null },
      recover: (value) => { visible = value },
    })
    const secondDelete = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => { throw new Error('404 binding missing') },
      refresh: async () => null,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: () => { visible = null },
      recover: (value) => { visible = value },
    })

    deleteGate.resolve()
    expect(await firstDelete).toBe('stale')
    expect(await secondDelete).toBe('failed')
    expect(persisted).toBeNull()
    expect(visible).toBeNull()
  })

  test('recovery refresh supersedes a delayed initial GET', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const initialFetchGate = deferred<{ preset_id: string }>()
    const recoveryStarted = deferred<void>()
    const recoveryGate = deferred<{ preset_id: string }>()
    const initialBinding = { preset_id: 'preset-initial' }
    const recoveredBinding = { preset_id: 'preset-recovered' }
    const currentBinding = { preset_id: 'preset-current' }
    const initialFetch = coordinator.beginFetch(scope)
    let visible = currentBinding

    const delayedInitialFetch = initialFetchGate.promise.then((value) => {
      if (coordinator.isFetchCurrent(scope, initialFetch)) visible = value
    })
    const recovery = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => { throw new Error('write failed') },
      refresh: async () => {
        recoveryStarted.resolve()
        return recoveryGate.promise
      },
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: (value) => { visible = value },
      recover: (value) => { visible = value },
    })

    await recoveryStarted.promise
    initialFetchGate.resolve(initialBinding)
    await delayedInitialFetch
    expect(visible).toBe(currentBinding)

    recoveryGate.resolve(recoveredBinding)
    expect(await recovery).toBe('failed')
    expect(visible).toBe(recoveredBinding)
  })

  test('preserves the last visible binding when recovery GET fails', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const visible = { preset_id: 'preset-old' }
    const initialFetch = coordinator.beginFetch(scope)
    let state = visible

    const result = await runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => { throw new Error('write failed') },
      refresh: async () => { throw new Error('read failed') },
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: (value) => { state = value },
      recover: (value) => { state = value },
    })

    expect(result).toBe('failed')
    expect(coordinator.isFetchCurrent(scope, initialFetch)).toBe(false)
    expect(state).toBe(visible)
  })

  test('drops delayed recovery from an older mutation after a newer write commits', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const refreshStarted = deferred<void>()
    const refreshGate = deferred<{ preset_id: string }>()
    const newerGate = deferred<void>()
    const oldBinding = { preset_id: 'preset-old' }
    const newBinding = { preset_id: 'preset-new' }
    const currentBinding = { preset_id: 'preset-current' }
    let visible = currentBinding

    const recovery = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => { throw new Error('write failed') },
      refresh: async () => {
        refreshStarted.resolve()
        return refreshGate.promise
      },
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: (value) => { visible = value },
      recover: (value) => { visible = value },
    })
    await refreshStarted.promise

    const newer = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => {
        await newerGate.promise
        return newBinding
      },
      refresh: async () => newBinding,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: (value) => { visible = value },
      recover: (value) => { visible = value },
    })
    refreshGate.resolve(oldBinding)

    expect(await recovery).toBe('stale')
    expect(visible).toBe(currentBinding)
    newerGate.resolve()
    expect(await newer).toBe('committed')
    expect(visible).toBe(newBinding)
  })

  test('target revisions remain independent when switching away and back', () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const firstA = coordinator.beginMutation('chat-binding:chat-a')
    const firstB = coordinator.beginMutation('chat-binding:chat-b')
    coordinator.beginMutation('chat-binding:chat-a')

    expect(coordinator.isMutationCurrent('chat-binding:chat-a', firstA)).toBe(false)
    expect(coordinator.isMutationCurrent('chat-binding:chat-b', firstB)).toBe(true)
  })

  test('does not start queued writes after mutation scope invalidation', async () => {
    const coordinator = createPresetProfileMutationCoordinator()
    const scope = 'chat-binding:chat-a'
    const firstGate = deferred<void>()
    const calls: string[] = []

    const first = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => {
        calls.push('first')
        await firstGate.promise
        return 'first'
      },
      refresh: async () => null,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: () => {},
      recover: () => {},
    })
    await Promise.resolve()
    await Promise.resolve()
    const second = runPresetProfileMutation({
      coordinator,
      scope,
      operation: async () => {
        calls.push('second')
        return 'second'
      },
      refresh: async () => null,
      isCurrent: (revision) => coordinator.isMutationCurrent(scope, revision),
      commit: () => {},
      recover: () => {},
    })

    coordinator.invalidateMutations()
    firstGate.resolve()
    expect(await first).toBe('stale')
    expect(await second).toBe('stale')
    expect(calls).toEqual(['first'])
  })
})
