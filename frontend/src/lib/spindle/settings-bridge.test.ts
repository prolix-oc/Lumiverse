import { describe, expect, test } from 'bun:test'

import { DATA_KEYS } from '@/store/slices/settings'
import { CORE_SETTING_KEYS, settingsAuthorityRows } from './core-setting-keys'
import {
  MAX_SETTING_VALUE_BYTES,
  createSettingsBridge,
  type SettingsUpdatedEvent,
} from './settings-bridge'

function createHarness() {
  const rows = new Map<string, unknown>()
  const coreValues = new Map<string, unknown>([
    ['theme', 'dark'],
    ['portraitDockSettings', {
      dockSide: 'left',
      rect: { x: 36, y: 48, width: 412, height: 548 },
    }],
  ])
  const coreSubscribers = new Map<string, Set<(value: unknown) => void>>()
  const events = new EventTarget()
  let settingsUpdatedHandler: ((event: SettingsUpdatedEvent) => void) | undefined

  const bridge = createSettingsBridge({
    manifestIdentifier: 'lumiverse_suite',
    coreSettingKeys: CORE_SETTING_KEYS,
    core: {
      get: (key) => coreValues.get(key),
      subscribe: (key, handler) => {
        const subscribers = coreSubscribers.get(key) ?? new Set<(value: unknown) => void>()
        subscribers.add(handler)
        coreSubscribers.set(key, subscribers)
        return () => {
          subscribers.delete(handler)
          if (subscribers.size === 0) coreSubscribers.delete(key)
        }
      },
    },
    persistence: {
      get: async (key) => rows.has(key) ? { value: rows.get(key) } : undefined,
      set: async (key, value) => rows.set(key, value),
      remove: async (key) => rows.delete(key),
    },
    onSettingsUpdated: (handler) => {
      settingsUpdatedHandler = handler
      return () => { settingsUpdatedHandler = undefined }
    },
    window: events,
  })

  return {
    bridge,
    rows,
    emitCore(key: string, value: unknown) {
      coreValues.set(key, value)
      for (const subscriber of coreSubscribers.get(key) ?? []) subscriber(value)
    },
    emitSettingsUpdated(event: SettingsUpdatedEvent) {
      settingsUpdatedHandler?.(event)
    },
    emitWindowSettingChanged(detail: SettingsUpdatedEvent) {
      const event = new Event('lumiverse:setting-changed')
      Object.defineProperty(event, 'detail', { value: detail })
      events.dispatchEvent(event)
    },
  }
}

describe('Spindle settings bridge', () => {
  test('uses only the host-composed namespace and rejects cross-extension keys', async () => {
    const harness = createHarness()

    await harness.bridge.set('quick_toolbar:enabled', true)
    expect(harness.rows.get('spindle:lumiverse_suite:quick_toolbar:enabled')).toBe(true)

    await expect(harness.bridge.set('spindle:other_extension:enabled', true)).rejects.toThrow(
      'SETTING_NAMESPACE_INVALID',
    )
    await expect(harness.bridge.set('quick_toolbar:enabled:extra', true)).rejects.toThrow(
      'SETTING_KEY_INVALID',
    )
    await expect(harness.bridge.set('quick toolbar:enabled', true)).rejects.toThrow(
      'SETTING_KEY_INVALID',
    )
  })

  test('rejects values above the settings service serialization cap before persistence', async () => {
    const harness = createHarness()

    await expect(
      harness.bridge.set('quick_toolbar:state', 'x'.repeat(MAX_SETTING_VALUE_BYTES)),
    ).rejects.toThrow(`SETTING_VALUE_TOO_LARGE:${MAX_SETTING_VALUE_BYTES}`)
    expect(harness.rows.size).toBe(0)
  })

  test('exposes exactly the audited core reads and no core write escape hatch', () => {
    const harness = createHarness()

    expect(harness.bridge.core.list()).toEqual(
      CORE_SETTING_KEYS.map(({ key, permission }) => ({ key, permission })),
    )
    expect(harness.bridge.core.get<string>('theme')).toBe('dark')
    expect(() => harness.bridge.core.get('missing')).toThrow('CORE_SETTING_UNKNOWN:missing')
    expect('set' in harness.bridge.core).toBe(false)
    expect('remove' in harness.bridge.core).toBe(false)
    expect(CORE_SETTING_KEYS.every(({ writable }) => writable === false)).toBe(true)
    expect(CORE_SETTING_KEYS.every(({ key }) => DATA_KEYS.has(key))).toBe(true)
  })

  test('projects every allowlisted core read and private namespace member', () => {
    const rows = settingsAuthorityRows()

    expect(rows).toHaveLength(CORE_SETTING_KEYS.length * 3 + 5)
    for (const definition of CORE_SETTING_KEYS) {
      const matchingRows = rows.filter((row) => row.source === definition.source)
      expect(matchingRows.map(({ id }) => id)).toEqual([
        `setting:${definition.key}`,
        `ctx.settings.core.get:${definition.key}`,
        `ctx.settings.core.watch:${definition.key}`,
      ])
      expect(matchingRows.every(({ permission, source }) => (
        Object.is(permission, definition.permission) && Object.is(source, definition.source)
      ))).toBe(true)
    }

    expect(rows.slice(-4).map(({ id, source, permission }) => ({ id, source, permission }))).toEqual([
      { id: 'ctx.settings.get', source: 'settings.spindle_namespace_own', permission: null },
      { id: 'ctx.settings.set', source: 'settings.spindle_namespace_own', permission: null },
      { id: 'ctx.settings.remove', source: 'settings.spindle_namespace_own', permission: null },
      { id: 'ctx.settings.watch', source: 'settings.spindle_namespace_own', permission: null },
    ])
  })

  test('notifies private watchers from extension and host event channels', async () => {
    const harness = createHarness()
    const values: unknown[] = []
    harness.bridge.watch('quick_toolbar:state', (value) => values.push(value))

    await harness.bridge.set('quick_toolbar:state', { enabled: false })
    harness.emitWindowSettingChanged({
      key: 'spindle:lumiverse_suite:quick_toolbar:state',
      value: { enabled: true },
    })
    harness.emitSettingsUpdated({
      key: 'spindle:lumiverse_suite:quick_toolbar:state',
      value: { enabled: false },
    })

    expect(values).toEqual([
      { enabled: false },
      { enabled: true },
      { enabled: false },
    ])
  })

  test('notifies core watchers from host store writes', () => {
    const harness = createHarness()
    const values: unknown[] = []
    harness.bridge.core.watch('theme', (value) => values.push(value))

    harness.emitCore('theme', 'light')

    expect(values).toEqual(['light'])
  })

  test('exposes the canonical portrait dock position independently of private refreshes', async () => {
    const harness = createHarness()
    const canonical = {
      dockSide: 'left',
      rect: { x: 36, y: 48, width: 412, height: 548 },
    }
    const stalePrivateFallback = {
      dockSide: 'right',
      rect: { x: 0, y: 0, width: 360, height: 520 },
    }
    const privateValues: unknown[] = []
    const coreValues: unknown[] = []

    harness.rows.set('spindle:lumiverse_suite:portrait_dock:portraitDockSettings', stalePrivateFallback)
    harness.bridge.watch('portrait_dock:portraitDockSettings', (value) => privateValues.push(value))
    harness.bridge.core.watch('portraitDockSettings', (value) => coreValues.push(value))

    harness.emitSettingsUpdated({
      keys: ['spindle:lumiverse_suite:portrait_dock:portraitDockSettings'],
    })
    await Promise.resolve()

    expect(privateValues).toEqual([stalePrivateFallback])
    expect(coreValues).toEqual([])
    expect(harness.bridge.core.get<typeof canonical>('portraitDockSettings')).toEqual(canonical)
  })

  test('teardown removes watchers and invalidates the generation', () => {
    const harness = createHarness()
    const privateValues: unknown[] = []
    const coreValues: unknown[] = []
    harness.bridge.watch('quick_toolbar:state', (value) => privateValues.push(value))
    harness.bridge.core.watch('theme', (value) => coreValues.push(value))

    harness.bridge.dispose()
    harness.emitWindowSettingChanged({
      key: 'spindle:lumiverse_suite:quick_toolbar:state',
      value: 'late',
    })
    harness.emitSettingsUpdated({
      key: 'spindle:lumiverse_suite:quick_toolbar:state',
      value: 'late',
    })
    harness.emitCore('theme', 'light')

    expect(privateValues).toEqual([])
    expect(coreValues).toEqual([])
    expect(() => harness.bridge.core.get('theme')).toThrow('SETTINGS_BRIDGE_DISPOSED')
  })
})
