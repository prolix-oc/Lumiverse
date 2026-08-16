import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acknowledgePendingConnectionsDeepLink } from '@/lib/uiProductivityDefaults'

const here = dirname(fileURLToPath(import.meta.url))

describe('App active profile', () => {
  test('awaits acknowledgement for a pending connections deep link', async () => {
    const pending = Promise.withResolvers<void>()
    const setIds: string[] = []
    let settled = false

    const acknowledged = acknowledgePendingConnectionsDeepLink({
      pending: { target: 'connections', provider: 'pollinations', connectionId: 'profile-1' },
      setActiveProfile: (id) => { setIds.push(id) },
      acknowledgeActive: () => pending.promise,
    }).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(setIds).toEqual(['profile-1'])
    expect(settled).toBe(false)

    pending.resolve()
    await acknowledged
    expect(settled).toBe(true)

    const source = readFileSync(join(here, 'App.tsx'), 'utf8')
    expect(source).toContain('acknowledgePendingConnectionsDeepLink')
    expect(source).toContain('setActiveProfile')
  })
})
