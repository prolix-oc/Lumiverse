import { describe, expect, test } from 'bun:test'

const css = await Bun.file(new URL('./App.module.css', import.meta.url)).text()

describe('desktop tint transition contract', () => {
  test('transitions only the committed surface color and respects reduced motion', () => {
    expect(css).toMatch(
      /html\[data-tauri-desktop\]\[data-desktop-background\][\s\S]*?\.app\s*\{[\s\S]*?background-color:\s*var\(--lumiverse-desktop-background\);[\s\S]*?transition:\s*background-color var\(--lcs-transition/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?html\[data-tauri-desktop\]\[data-desktop-background\][\s\S]*?\.app\s*\{[\s\S]*?transition:\s*none;/,
    )
  })
})
