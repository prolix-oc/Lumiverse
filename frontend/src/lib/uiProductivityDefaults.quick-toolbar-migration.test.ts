/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { migrateProductivitySetting } from './uiProductivityDefaults'

describe('quick toolbar viewport geometry migration', () => {
  test('releases an old floating V2 rectangle once while preserving its position', () => {
    const migrated = migrateProductivitySetting('quickToolbarSettings', {
      variant: 'v2-settings-adjacent',
      quickToolbarPlacement: 'floating',
      rect: { x: 554, y: 6, width: 763, height: 33 },
      rectVersion: 3,
    }) as { rect: { x: number; y: number; width: number; height: number }; v2ViewportGeometryVersion: number }

    expect(migrated.rect).toEqual({ x: 554, y: 6, width: 0, height: 0 })
    expect(migrated.v2ViewportGeometryVersion).toBe(2)
  })

  test('does not overwrite a rectangle already migrated by the viewport fix', () => {
    const value = {
      variant: 'v2-settings-adjacent',
      quickToolbarPlacement: 'floating',
      rect: { x: 1467, y: 0, width: 453, height: 32 },
      v2ViewportGeometryVersion: 2,
    }

    expect(migrateProductivitySetting('quickToolbarSettings', value)).toEqual(value)
  })
})
