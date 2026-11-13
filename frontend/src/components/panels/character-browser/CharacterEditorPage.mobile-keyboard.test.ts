/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'

const css = await Bun.file(new URL('./CharacterEditorPage.module.css', import.meta.url)).text()

describe('CharacterEditorPage mobile keyboard layout', () => {
  test('does not reserve the keyboard inset after a Chromium PWA resizes the viewport', () => {
    const resizedPwaRule = css.match(
      /:global\(html\[data-pwa\]\[data-resizes-content\]\) \.tabContent\s*\{([^}]*)\}/,
    )

    expect(resizedPwaRule).not.toBeNull()
    expect(resizedPwaRule?.[1]).toContain(
      'padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));',
    )
    expect(resizedPwaRule?.[1]).toContain(
      'scroll-padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));',
    )
    expect(resizedPwaRule?.[1]).not.toContain('--app-keyboard-inset-bottom')
  })
})
