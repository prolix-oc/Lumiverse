/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./LoginPage.tsx', import.meta.url)).text()
const css = await Bun.file(new URL('./LoginPage.module.css', import.meta.url)).text()

describe('LoginPage mobile keyboard layout', () => {
  test('does not reserve the keyboard inset after an Android PWA resizes the viewport', () => {
    const resizedPwaRule = css.match(
      /:global\(html\[data-pwa\]\[data-resizes-content\]\) \.page\s*\{([^}]*)\}/,
    )

    expect(resizedPwaRule).not.toBeNull()
    expect(resizedPwaRule?.[1]).toContain('--login-keyboard-inset-bottom: 0px;')
    expect(css.match(/--app-keyboard-inset-bottom/g)).toHaveLength(1)
    expect(css).toContain('padding-bottom: calc(32px + var(--login-keyboard-inset-bottom));')
    expect(css).toContain('scroll-padding-block: 24px calc(32px + var(--login-keyboard-inset-bottom));')
  })

  test('waits for the resized viewport to settle before one fallback reveal', () => {
    expect(source).toContain("root.hasAttribute('data-pwa') && root.hasAttribute('data-resizes-content')")
    expect(source).toContain('LOGIN_FOCUS_RESIZED_VIEWPORT_SETTLE_DELAY')
    expect(source).toContain("window.visualViewport?.addEventListener('resize', scheduleSettledReveal)")
    expect(source).toContain("window.visualViewport?.removeEventListener('resize', scheduleSettledReveal)")
    expect(source).toContain('clearTimeout(resizedViewportTimer)')
  })
})
