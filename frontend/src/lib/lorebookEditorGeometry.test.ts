import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_FULL_EDITOR_RECT,
  resolveWindowedEditorRect,
} from './lorebookEditorGeometry'

describe('resolveWindowedEditorRect', () => {
  test('repairs a phone-sized saved rectangle when restoring on desktop', () => {
    expect(resolveWindowedEditorRect(
      { width: 440, height: 956 },
      { width: 1400, height: 1000 },
    )).toEqual({ x: 16, y: 80, width: 1368, height: 840 })
  })

  test('preserves a normal user-sized desktop rectangle', () => {
    expect(resolveWindowedEditorRect(
      { width: 900, height: 700 },
      { width: 1400, height: 1000 },
    )).toEqual({ x: 250, y: 150, width: 900, height: 700 })
  })

  test('keeps the staging desktop default as the recovery target', () => {
    expect(DEFAULT_FULL_EDITOR_RECT).toEqual({ x: 48, y: 36, width: 1540, height: 840 })
  })
})
