import { describe, expect, test } from 'bun:test'
import { shareExtensionLoad } from './extension-load-flight'

describe('extension load flight', () => {
  test('shares concurrent startup loads and permits a later refresh', async () => {
    let release!: () => void
    const deferred = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const run = async () => {
      calls += 1
      await deferred
    }

    const first = shareExtensionLoad(run)
    const second = shareExtensionLoad(run)
    expect(first).toBe(second)
    expect(calls).toBe(1)

    release()
    await Promise.all([first, second])
    await shareExtensionLoad(async () => { calls += 1 })
    expect(calls).toBe(2)
  })
})
