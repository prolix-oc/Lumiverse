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

  test('moves a fixed shine texture and derives parallax from normalized pointer variables', async () => {
    const [css, source] = await Promise.all([
      Bun.file(new URL('./LandingPage.module.css', import.meta.url)).text(),
      Bun.file(new URL('./LandingPage.tsx', import.meta.url)).text(),
    ])

    expect(css).toMatch(/\.cardShine\s*\{[\s\S]*?circle at 50% 50%[\s\S]*?translate3d\([\s\S]*?--pointer-x[\s\S]*?--pointer-y/)
    expect(css).toMatch(/\.cardTilt\.tilting\s*\{[\s\S]*?rotateX\(calc\(var\(--pointer-y[\s\S]*?rotateY\(calc\(var\(--pointer-x/)
    expect(css).not.toMatch(/circle at var\(--shine-/)
    expect(source).not.toMatch(/setProperty\('--shine-/)
    expect(source).not.toMatch(/tilt\.style\.transform\s*=/)
  })

  test('reveals Shift remove actions only for the hovered or focused card', async () => {
    const css = await Bun.file(new URL('./LandingPage.module.css', import.meta.url)).text()

    expect(css).not.toMatch(/(^|,)\s*\.deleteBtnShift\s*(,|\{)/m)
    expect(css).not.toMatch(/(^|,)\s*\.listDeleteBtnShift\s*(,|\{)/m)
    expect(css).toMatch(/\.card:hover \.deleteBtnShift,\s*\.card:focus-within \.deleteBtnShift/)
    expect(css).toMatch(/\.listItem:hover \.listDeleteBtnShift,\s*\.listItem:focus-within \.listDeleteBtnShift/)
  })
})
