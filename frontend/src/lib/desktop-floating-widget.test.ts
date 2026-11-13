import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const originalWindow = globalThis.window

beforeAll(() => {
  Object.assign(globalThis, { window: {} })
})

afterAll(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.assign(globalThis, { window: originalWindow })
})

describe('desktop floating widget catalog', () => {
  test('does not publish widgets owned by disabled or backend-only extensions', async () => {
    const { buildDesktopFloatingWidgetCatalog } = await import('./desktop-floating-widget')
    const widget = (id: string, extensionId: string) => ({
      id,
      extensionId,
      visible: true,
      width: 320,
      height: 180,
      chromeless: false,
    })
    const extension = (id: string, enabled: boolean, hasFrontend: boolean) => ({
      id,
      name: id,
      enabled,
      has_frontend: hasFrontend,
    })

    const catalog = buildDesktopFloatingWidgetCatalog(
      [widget('disabled-widget', 'disabled'), widget('backend-widget', 'backend'), widget('active-widget', 'active')] as never,
      [extension('disabled', false, true), extension('backend', true, false), extension('active', true, true)] as never,
    )

    expect(catalog.map((entry) => entry.id)).toEqual(['active-widget'])
  })

  test('keeps collapsed chromeless bounds while retaining safe chromed minimums', async () => {
    const { buildDesktopFloatingWidgetCatalog } = await import('./desktop-floating-widget')
    const extension = {
      id: 'active',
      name: 'Active',
      enabled: true,
      has_frontend: true,
    }
    const widget = (id: string, chromeless: boolean) => ({
      id,
      extensionId: 'active',
      visible: true,
      width: 48,
      height: 48,
      chromeless,
    })

    const catalog = buildDesktopFloatingWidgetCatalog(
      [widget('compact', true), widget('chromed', false)] as never,
      [extension] as never,
    )

    expect(catalog[0]).toMatchObject({ id: 'compact', width: 48, height: 48 })
    expect(catalog[1]).toMatchObject({ id: 'chromed', width: 160, height: 100 })
  })
})
