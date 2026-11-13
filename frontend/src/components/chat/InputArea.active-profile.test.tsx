import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acknowledgeConnectionProfileSelection } from '@/lib/uiProductivityDefaults'

const here = dirname(fileURLToPath(import.meta.url))

describe('InputArea active profile', () => {
  test('awaits profile acknowledgement before closing the connection popover', async () => {
    const pending = Promise.withResolvers<void>()
    const setIds: string[] = []
    const closes: number[] = []
    let settled = false

    const acknowledged = acknowledgeConnectionProfileSelection({
      profileId: 'beta',
      setActiveProfile: (id) => { if (id) setIds.push(id) },
      acknowledgeActive: () => pending.promise,
      closePopover: () => { closes.push(1) },
    }).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(setIds).toEqual(['beta'])
    expect(closes).toEqual([])
    expect(settled).toBe(false)

    pending.resolve()
    await acknowledged
    expect(closes).toEqual([1])
    expect(settled).toBe(true)

    const source = readFileSync(join(here, 'InputArea.tsx'), 'utf8')
    expect(source).toContain('acknowledgeConnectionProfileSelection')
    expect(source).toContain('closePopover')
  })
})
