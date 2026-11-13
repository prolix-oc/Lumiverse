import { describe, expect, test } from 'bun:test'
import { HostSurfaceRegistry } from './host-surface-registry'

describe('generation-scoped host surface registry', () => {
  test('registers, publishes, removes, and caps owned entries', () => {
    const registry = new HostSurfaceRegistry<{ label: string }>({ maxEntries: 1 })
    const seen: number[] = []
    registry.subscribe((entries) => seen.push(entries.length))
    const dispose = registry.register('one', { label: 'One' }, 4)
    expect(registry.list().map((entry) => entry.id)).toEqual(['one'])
    expect(() => registry.register('two', { label: 'Two' }, 4)).toThrow('HOST_SURFACE_LIMIT')
    dispose()
    expect(registry.list()).toEqual([])
    expect(seen).toEqual([1, 0])
  })

  test('generation cleanup is precise and teardown is terminal', () => {
    const registry = new HostSurfaceRegistry<{ label: string }>()
    registry.register('old', { label: 'Old' }, 1)
    registry.register('current', { label: 'Current' }, 2)
    registry.clearGeneration(1)
    expect(registry.list().map((entry) => entry.id)).toEqual(['current'])
    registry.dispose()
    expect(() => registry.list()).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })
})
