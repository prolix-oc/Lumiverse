/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const spindleDir = import.meta.dir
const frontendDir = join(spindleDir, '..', '..')

describe('Spindle modal geometry integration contract', () => {
  test('frontend-owned modal roots use the shared scale-aware geometry resolver', () => {
    const loader = readFileSync(join(spindleDir, 'loader.ts'), 'utf8')

    expect(loader).toContain("import { resolveCurrentSpindleModalGeometry } from './modal-geometry'")
    expect(loader).toContain('const geometry = resolveCurrentSpindleModalGeometry(options)')
    expect(loader).toContain('width: `${geometry.width}px`')
    expect(loader).toContain('maxHeight: `${geometry.maxHeight}px`')
    expect(loader).not.toContain("Math.min(options?.width || 420, window.innerWidth - 40)")
    expect(loader).not.toContain("Math.min(options?.maxHeight || 520, window.innerHeight - 40)")
  })

  test('worker-backed modal renderer uses the same resolver', () => {
    const manager = readFileSync(join(frontendDir, 'components', 'spindle', 'SpindleUIManager.tsx'), 'utf8')

    expect(manager).toContain("import { resolveCurrentSpindleModalGeometry } from '@/lib/spindle/modal-geometry'")
    expect(manager).toContain('const geometry = resolveCurrentSpindleModalGeometry(req)')
    expect(manager).toContain('width: geometry.width')
    expect(manager).toContain('maxHeight: geometry.maxHeight')
    expect(manager).not.toContain('width: Math.min(req.width || 420, window.innerWidth - 40)')
    expect(manager).not.toContain('maxHeight: Math.min(req.maxHeight || 520, window.innerHeight - 40)')
  })
})
