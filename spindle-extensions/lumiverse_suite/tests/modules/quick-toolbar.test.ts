import { describe, expect, test } from 'bun:test'
import { createQuickToolbarModule } from '../../src/modules/quick_toolbar'

type Surface = { id: string; props: Record<string, unknown>; updates: Record<string, unknown>[]; destroys: number; listeners: Set<(payload: unknown) => void> }

function harness(value: unknown, failures: { mount?: boolean; update?: boolean } = {}, core?: unknown) {
  let watch: ((value: unknown) => void) | undefined
  const surfaces: Surface[] = []
  const points: string[] = []
  const context = {
    host: { extensionInstallationId: 'quick-test', ui: { mount: (point: string) => { points.push(point); return {} } }, components: { mountHostSurface: (_root: unknown, id: string, props: Record<string, unknown>) => { if (failures.mount) throw new Error('MOUNT_FAILED'); const surface: Surface = { id, props: { ...props }, updates: [], destroys: 0, listeners: new Set() }; surfaces.push(surface); return { update: (next: Record<string, unknown>) => { if (failures.update) throw new Error('UPDATE_FAILED'); surface.updates.push(next); Object.assign(surface.props, next) }, destroy: () => { surface.destroys++ }, on: (_event: string, listener: (payload: unknown) => void) => { surface.listeners.add(listener); return () => surface.listeners.delete(listener) } } } } },
    settings: { get: async () => value, set: async (_key: string, next: unknown) => { value = next }, remove: async () => undefined, watch: (_key: string, listener: (next: unknown) => void) => { watch = listener; return () => { watch = undefined } }, core: { get: () => core, watch: () => () => undefined, list: () => [] } },
  } as never
  return { context, surfaces, points, set: (next: unknown) => watch?.(next) }
}

describe('quick_toolbar host-surface lifecycle', () => {
  test('mounts the canonical surface with owner, generation, state, and variant-specific point', async () => {
    const h = harness({ enabled: true, variant: 'v2', rectVersion: 2 })
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    expect(h.points).toEqual(['chat_top_dock'])
    expect(h.surfaces[0]).toMatchObject({ id: 'quick_toolbar.workspace', props: { ownerToken: 'quick-test', generation: 2, state: { enabled: true, variant: 'v2' } } })
    await module.stop()
    expect(h.surfaces[0]?.destroys).toBe(1)
  })

  test('updates canonical props on settings changes and destroys once when disabled', async () => {
    const h = harness({ enabled: true, variant: 'v1' })
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    h.set({ enabled: true, variant: 'v2' })
    expect(h.points).toEqual(['chat_surface_side', 'chat_top_dock'])
    expect(h.surfaces[0]?.destroys).toBe(1)
    expect(h.surfaces[1]?.props.state).toMatchObject({ enabled: true, variant: 'v2' })
    h.set({ enabled: false, variant: 'v2' })
    expect(h.surfaces[1]?.destroys).toBe(1)
    await module.stop(); await module.stop()
    expect(h.surfaces.map(s => s.destroys)).toEqual([1, 1])
  })

  test('remounts from V2 back to V1 and cleans every mounted root once', async () => {
    const h = harness({ enabled: true, variant: 'v2' })
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    h.set({ enabled: true, variant: 'v1' })

    expect(h.points).toEqual(['chat_top_dock', 'chat_surface_side'])
    expect(h.surfaces[0]?.destroys).toBe(1)
    expect(h.surfaces[1]?.props.state).toMatchObject({ enabled: true, variant: 'v1' })

    await module.stop()
    expect(h.surfaces.map(surface => surface.destroys)).toEqual([1, 1])
  })

  test('mounts a fresh generation when re-enabled after disablement', async () => {
    const h = harness({ enabled: true, variant: 'v2' })
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    h.set({ enabled: false, variant: 'v2' })
    h.set({ enabled: true, variant: 'v2' })

    expect(h.points).toEqual(['chat_top_dock', 'chat_top_dock'])
    expect(h.surfaces.map(surface => surface.destroys)).toEqual([1, 0])
    expect(h.surfaces[1]?.props).toMatchObject({ generation: 5, state: { enabled: true, variant: 'v2' } })

    await module.stop()
    expect(h.surfaces.map(surface => surface.destroys)).toEqual([1, 1])
  })

  test('skips ui.mount and workspace when core placement is chat_top_dock for normalized V2', async () => {
    const h = harness(
      { enabled: true, variant: 'v2' },
      {},
      { enabled: true, variant: 'v2', quickToolbarPlacement: 'chat_top_dock' },
    )
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    expect(h.points).toEqual([])
    expect(h.surfaces).toEqual([])
    await module.stop()
  })

  test('still mounts V1 when core placement is chat_top_dock', async () => {
    const h = harness(
      { enabled: true, variant: 'v1' },
      {},
      { enabled: true, variant: 'v1', quickToolbarPlacement: 'chat_top_dock' },
    )
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    expect(h.points).toEqual(['chat_surface_side'])
    expect(h.surfaces[0]).toMatchObject({ id: 'quick_toolbar.workspace' })
    await module.stop()
    expect(h.surfaces[0]?.destroys).toBe(1)
  })

  test('still mounts floating V2 when core placement is floating', async () => {
    const h = harness(
      { enabled: true, variant: 'v2' },
      {},
      { enabled: true, variant: 'v2', quickToolbarPlacement: 'floating' },
    )
    const module = createQuickToolbarModule(h.context)
    await module.start(h.context)
    expect(h.points).toEqual(['chat_top_dock'])
    expect(h.surfaces[0]).toMatchObject({ id: 'quick_toolbar.workspace', props: { state: { enabled: true, variant: 'v2' } } })
    await module.stop()
  })

  test('reports host-surface mount and update failures after cleanup', async () => {
    const mountFailure = harness({ enabled: true, variant: 'v2' }, { mount: true })
    await expect(createQuickToolbarModule(mountFailure.context).start(mountFailure.context)).rejects.toThrow('MOUNT_FAILED')

    const updateFailure = harness({ enabled: true, variant: 'v2' }, { update: true })
    const module = createQuickToolbarModule(updateFailure.context)
    await module.start(updateFailure.context)
    expect(() => updateFailure.set({ enabled: true, variant: 'v2', labelVisible: false })).toThrow('UPDATE_FAILED')
    expect(updateFailure.surfaces[0]?.destroys).toBe(1)
  })
})
