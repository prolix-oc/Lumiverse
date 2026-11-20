import { describe, expect, test } from 'bun:test'
import { Waypoints } from 'lucide-react'
import { actionIcon } from './InputBarExtensionActions.icons'

describe('InputBarExtensionActions icon mapping', () => {
  test('maps waypoints to the Lucide Waypoints icon', () => {
    const icon = actionIcon('waypoints')
    expect(icon).not.toBeNull()
    expect((icon as { type?: unknown }).type).toBe(Waypoints)
  })

  test('does not invent icons for unknown names', () => {
    expect(actionIcon('unknown')).toBeNull()
  })
})
