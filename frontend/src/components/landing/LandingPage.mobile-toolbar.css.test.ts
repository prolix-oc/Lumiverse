import { describe, expect, test } from 'bun:test'

function lastAtRuleBlock(css: string, prelude: string): string {
  const start = css.lastIndexOf(prelude)
  expect(start, `expected ${prelude} at-rule to exist`).toBeGreaterThanOrEqual(0)

  const openingBrace = css.indexOf('{', start)
  let depth = 0
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(openingBrace + 1, index)
  }

  throw new Error(`expected ${prelude} at-rule to close`)
}

describe('LandingPage mobile toolbar', () => {
  test('preserves space for Chats search when the Suite adds the Characters tab', async () => {
    const css = await Bun.file(new URL('./LandingPage.module.css', import.meta.url)).text()
    const mobile = lastAtRuleBlock(css, '@media (max-width: 600px)')

    expect(mobile).toMatch(/\.landingTabsWithSuite\s+\.landingTabLabel\s*\{[\s\S]*?clip:\s*rect\(0,\s*0,\s*0,\s*0\)/)
    expect(mobile).toMatch(/\.galleryWidthBtn\s*\{\s*display:\s*none/)
  })
})
