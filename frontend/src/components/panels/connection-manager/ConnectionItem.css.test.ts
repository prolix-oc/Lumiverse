import { describe, expect, test } from 'bun:test'

describe('ConnectionItem theme tokens', () => {
  test('uses radius-scale and warning tokens instead of fixed picker-era literals', async () => {
    const css = await Bun.file(new URL('./ConnectionItem.module.css', import.meta.url)).text()
    expect(css).not.toMatch(/border-radius:\s*(?:10px|8px|4px)/)
    expect(css).not.toContain('#f5a623')
    expect(css).toContain('var(--lumiverse-radius-md)')
    expect(css).toContain('var(--lumiverse-radius-sm)')
    expect(css).toContain('var(--lumiverse-warning)')
  })
})
