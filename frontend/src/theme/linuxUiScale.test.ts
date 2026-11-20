import { describe, expect, test } from 'bun:test'

const [resetCss, mainSource] = await Promise.all([
  Bun.file(new URL('./reset.css', import.meta.url)).text(),
  Bun.file(new URL('../main.tsx', import.meta.url)).text(),
])

describe('Linux desktop UI scale contract', () => {
  test('tags Linux runtimes and uses composable scaling instead of WebKitGTK zoom', () => {
    expect(mainSource).toMatch(/\^Linux[\s\S]*setAttribute\('data-platform', 'linux'\)/)
    expect(resetCss).toMatch(
      /html\[data-tauri-desktop\]\[data-platform='linux'\] body\s*\{[\s\S]*?zoom:\s*1;[\s\S]*?scale:\s*var\(--lumiverse-ui-scale, 1\);[\s\S]*?transform-origin:\s*top left;/,
    )
  })
})
