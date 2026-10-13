/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, 'MessageEditArea.module.css'), 'utf8')
const component = readFileSync(join(import.meta.dir, 'MessageEditArea.tsx'), 'utf8')

function readCssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing CSS block: ${marker}`)

  const openingBrace = source.indexOf('{', markerIndex)
  if (openingBrace < 0) throw new Error(`Missing opening brace for: ${marker}`)

  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBrace + 1, index)
  }

  throw new Error(`Missing closing brace for: ${marker}`)
}

describe('MessageEditArea scrolling contract', () => {
  test('keeps a bounded message editor natively scrollable', () => {
    const editTextarea = readCssBlock(css, '.editTextarea {')

    expect(editTextarea).toMatch(/max-height:\s*65vh/)
    expect(editTextarea).toMatch(/overflow-y:\s*auto/)
    expect(editTextarea).toMatch(/overflow-x:\s*hidden/)
    expect(editTextarea).toMatch(/overscroll-behavior-y:\s*contain/)
    expect(editTextarea).toMatch(/-webkit-overflow-scrolling:\s*touch/)
  })

  test('auto-sizing cannot override native scrolling inline', () => {
    const autoResizeStart = component.indexOf('function autoResize(')
    const autoResizeEnd = component.indexOf('\nfunction getEditorOcclusion', autoResizeStart)
    const autoResize = component.slice(autoResizeStart, autoResizeEnd)

    expect(autoResizeStart).toBeGreaterThan(-1)
    expect(autoResizeEnd).toBeGreaterThan(autoResizeStart)
    expect(autoResize).toContain("el.style.height = 'auto'")
    expect(autoResize).not.toContain('style.overflowY')
  })
})
