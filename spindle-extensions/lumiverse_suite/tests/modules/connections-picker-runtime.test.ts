import { describe, expect, test } from 'bun:test'
import { createConnectionsPickerModule } from '../../src/modules/connections_picker'

type Surface = { id: string; props: Record<string, unknown>; updates: Record<string, unknown>[]; destroys: number; commands: Set<(payload: unknown) => void> }
type InputAction = { options: Record<string, unknown>; clicks: Set<() => void>; destroys: number }

function makeHarness(initial: unknown = { enabled: true, variant: 'A' }) {
  let legacyWatch: ((value: unknown) => void) | undefined
  let coreWatch: ((value: unknown) => void) | undefined
  const surfaces: Surface[] = []
  const actions: InputAction[] = []
  const points: string[] = []
  const context = {
    host: { extensionInstallationId: 'connections-test', ui: {
      mount: (point: string) => { points.push(point); return {} },
      registerInputBarAction: (options: Record<string, unknown>) => {
        const action: InputAction = { options, clicks: new Set(), destroys: 0 }
        actions.push(action)
        return {
          onClick: (listener: () => void) => { action.clicks.add(listener); return () => action.clicks.delete(listener) },
          destroy: () => { action.destroys++ },
        }
      },
    }, components: { mountHostSurface: (_root: unknown, id: string, props: Record<string, unknown>) => { const surface: Surface = { id, props: { ...props }, updates: [], destroys: 0, commands: new Set() }; surfaces.push(surface); return { update: (next: Record<string, unknown>) => { surface.updates.push(next); Object.assign(surface.props, next) }, destroy: () => { surface.destroys++ }, on: (event: string, listener: (payload: unknown) => void) => { if (event === 'command') surface.commands.add(listener); return () => surface.commands.delete(listener) } } } } },
    settings: { get: async () => initial, set: async (_key: string, value: unknown) => { initial = value }, remove: async () => undefined, watch: (_key: string, listener: (value: unknown) => void) => { legacyWatch = listener; return () => { legacyWatch = undefined } }, core: { get: () => undefined, watch: (_key: string, listener: (value: unknown) => void) => { coreWatch = listener; return () => { coreWatch = undefined } }, list: () => [] } },
  } as never
  return { context, surfaces, actions, points, setLegacy: (v: unknown) => legacyWatch?.(v), setCore: (v: unknown) => coreWatch?.(v), emit: (s: Surface, p: unknown) => s.commands.forEach(listener => listener(p)), click: (action: InputAction) => action.clicks.forEach(listener => listener()) }
}

describe('connections picker canonical runtime', () => {
  test('registers quick toolbar action only while enabled and exposes canonical state', async () => {
    const h = makeHarness({ enabled: true, variant: 'B' }); const module = createConnectionsPickerModule(); await module.start(h.context)
    expect(h.actions[0]?.options).toMatchObject({ id: 'lumiverse_suite.connections_picker.open', label: 'Connections Picker', placement: 'quick_toolbar', iconName: 'waypoints', enabled: true })
    h.setLegacy({ enabled: false, variant: 'B' }); await module.stop(); await module.stop()
  })

  test('opens the panel when invoked through its Quick Toolbar action', async () => {
    const h = makeHarness(); const module = createConnectionsPickerModule(); await module.start(h.context)
    h.click(h.actions[0]!)
    expect(h.surfaces.map(surface => surface.id)).toEqual(['connections_picker.panel'])
    await module.stop()
    expect(h.actions[0]?.destroys).toBe(1)
  })

  test('opens and closes panel properly', async () => {
    const h = makeHarness(); const module = createConnectionsPickerModule(); await module.start(h.context)
    h.click(h.actions[0]!)
    expect(h.surfaces.map(s => s.id)).toEqual(['connections_picker.panel'])
    const panel = h.surfaces[0]!; expect(panel.props).toMatchObject({ capabilities: ['close'], state: { open: true } }); await module.stop(); expect(h.surfaces.map(s => s.destroys)).toEqual([1])
  })

  test('treats canonical core settings as authoritative and updates existing surfaces', async () => {
    const h = makeHarness({ enabled: true, variant: 'A' }); const module = createConnectionsPickerModule(); await module.start(h.context)
    h.click(h.actions[0]!)
    const panel = h.surfaces[0]!; h.setCore({ enabled: true, variant: 'C' }); h.setLegacy({ enabled: false, variant: 'A' }); expect(panel.updates.at(-1)?.state).toMatchObject({ enabled: true, variant: 'C', open: true }); await module.stop()
  })
})
