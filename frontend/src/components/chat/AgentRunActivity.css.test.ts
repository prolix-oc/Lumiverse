import { describe, expect, test } from 'bun:test'

const cssPath = new URL('./AgentRunActivity.module.css', import.meta.url)
const tokenPath = new URL('../../theme/variables.css', import.meta.url)

describe('AgentRunActivity responsive accessibility contract', () => {
  test('uses the shared 44px target token for every interactive control family', async () => {
    const [css, tokens] = await Promise.all([
      Bun.file(cssPath).text(),
      Bun.file(tokenPath).text(),
    ])
    expect(tokens).toContain('--lumiverse-control-min: 44px')
    expect(css).toMatch(/\.strip[\s\S]*min-block-size:\s*var\(--lumiverse-control-min\)/)
    expect(css).toMatch(/\.closeButton[\s\S]*min-block-size:\s*var\(--lumiverse-control-min\)/)
    expect(css).toMatch(/\.tabs button[\s\S]*min-block-size:\s*var\(--lumiverse-control-min\)/)
    expect(css).toMatch(/\.sectionToggle[\s\S]*min-block-size:\s*var\(--lumiverse-control-min\)/)
    expect(css).toMatch(/\.secondaryButton[\s\S]*min-block-size:\s*var\(--lumiverse-control-min\)/)
  })

  test('provides mobile full-height, safe-area, keyboard viewport, focus, and reduced-motion rules', async () => {
    const css = await Bun.file(cssPath).text()
    expect(css).toContain('height: 100dvh')
    expect(css).toContain('env(safe-area-inset-top)')
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.surface[\s\S]*width:\s*100%/)
    expect(css).toMatch(/:focus-visible[\s\S]*outline:/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition:\s*none/)
  })
})
