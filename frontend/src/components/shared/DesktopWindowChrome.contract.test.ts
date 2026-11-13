import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const resetCss = await Bun.file(new URL('../../theme/reset.css', import.meta.url)).text()
const titlebarCss = await Bun.file(new URL('./DesktopPwaTitlebar.module.css', import.meta.url)).text()
const titlebarComponent = await Bun.file(new URL('./DesktopPwaTitlebar.tsx', import.meta.url)).text()
const connectionOverlayCss = await Bun.file(new URL('./ConnectionLostOverlay.module.css', import.meta.url)).text()
const drawerCss = await Bun.file(new URL('../panels/ViewportDrawer.module.css', import.meta.url)).text()
const customCssDock = await Bun.file(new URL('../modals/CustomCSSDock.module.css', import.meta.url)).text()
const spindleDock = await Bun.file(new URL('../spindle/SpindleDockPanel.module.css', import.meta.url)).text()
const spindleDockComponent = await Bun.file(new URL('../spindle/SpindleDockPanel.tsx', import.meta.url)).text()
const desktopFrontend = await Bun.file(
  new URL('../../../../desktop/src-tauri/src/frontend.rs', import.meta.url),
).text()

describe('desktop window chrome contract', () => {
  test('derives every Tauri content inset from the canonical titlebar height', () => {
    const cssHeight = resetCss.match(/--app-desktop-titlebar-height:\s*(\d+)px/)?.[1]
    const nativeHeight = desktopFrontend.match(/const FRONTEND_TITLEBAR_HEIGHT:\s*u32\s*=\s*(\d+);/)?.[1]

    expect(cssHeight).toBeDefined()
    expect(nativeHeight).toBe(cssHeight)
    expect(resetCss).toMatch(
      /html\[data-tauri-desktop\][\s\S]*--app-window-controls-overlay-top:\s*var\(--app-desktop-titlebar-height\)/,
    )
    expect(resetCss).toMatch(
      /html\[data-tauri-desktop\][\s\S]*--app-interactive-safe-top:\s*var\(--app-desktop-titlebar-height\)/,
    )
    expect(titlebarCss).toMatch(/height:\s*var\(--app-desktop-titlebar-height,\s*36px\)/)
    expect(desktopFrontend).not.toContain("set('--app-interactive-safe-top'")
    expect(desktopFrontend).not.toContain("set('--app-window-controls-overlay-top'")
  })

  test('uses the complete Window Controls Overlay rectangle as the safe boundary', () => {
    expect(resetCss).toContain(
      'calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 32px))',
    )
    expect(resetCss).toContain(
      '--app-interactive-safe-top: max(\n      env(safe-area-inset-top, 0px),\n      var(--app-window-controls-overlay-top)',
    )
    expect(titlebarCss).toMatch(/height:\s*var\(--app-window-controls-overlay-top,\s*32px\)/)
  })

  test('gives live and startup chrome one drag owner with an almost full-width hit target', () => {
    expect(titlebarComponent).toContain('getCurrentWindow().startDragging()')
    expect(titlebarComponent).toContain('event.detail !== 1')
    expect(titlebarComponent).not.toContain('data-tauri-drag-region')
    expect(titlebarCss).toMatch(/inset:\s*1px 1px 0/)

    expect(desktopFrontend).toContain('data-tauri-drag-region="deep"')
    expect(desktopFrontend).toMatch(/\.lumiverse-startup-drag\{\{[^}]*pointer-events:auto/)
  })

  test('rounds only the top of the Tauri titlebar and matches Windows window corners', () => {
    const cssRadius = resetCss.match(/--desktop-window-corner-radius:\s*(\d+)px/)?.[1]
    const nativeRadius = desktopFrontend.match(/const FRONTEND_CORNER_RADIUS:\s*u32\s*=\s*(\d+);/)?.[1]
    const windowsCssRadius = resetCss.match(/data-desktop-windows-corners="rounded"\]\s*\{\s*--desktop-window-corner-radius:\s*(\d+)px/)?.[1]
    const windowsNativeRadius = desktopFrontend.match(/const FRONTEND_WINDOWS_CORNER_RADIUS:\s*u32\s*=\s*(\d+);/)?.[1]

    expect(cssRadius).toBeDefined()
    expect(nativeRadius).toBe(cssRadius)
    expect(windowsNativeRadius).toBe(windowsCssRadius)
    expect(resetCss).toMatch(/data-desktop-windows-corners="square"\]\s*\{\s*--desktop-window-corner-radius:\s*0px/)
    expect(titlebarCss).toMatch(
      /html\[data-tauri-desktop\][\s\S]*?\.titlebar\s*\{[\s\S]*?border-radius:\s*var\(--desktop-window-corner-radius\) var\(--desktop-window-corner-radius\) 0 0/,
    )
    expect(desktopFrontend).toContain(`border-radius:{corner_radius}px {corner_radius}px 0 0;overflow:hidden`)
    expect(desktopFrontend).toContain("root.setAttribute('data-desktop-windows-corners', '{windows_corners}')")
    expect(desktopFrontend).toContain('.shadow(rounded_windows)')
    expect(desktopFrontend).toMatch(/window\s*\.set_shadow\(rounded_windows\)/)
  })

  test('keeps desktop chrome outside the connection hard-stop', () => {
    expect(connectionOverlayCss).toMatch(
      /html\[data-tauri-desktop\][\s\S]*\.backdrop[\s\S]*top:\s*var\(--app-desktop-titlebar-height/,
    )
    expect(connectionOverlayCss).toMatch(
      /height:\s*max\([\s\S]*--app-scaled-viewport-height[\s\S]*--app-desktop-titlebar-height/,
    )
  })

  test('keeps host panels on the shared safe boundary without platform duplicates', () => {
    expect(drawerCss).toMatch(/top:\s*var\(--app-interactive-safe-top/)
    expect(drawerCss).not.toMatch(/data-tauri-desktop|titlebar-area-height/)

    expect(customCssDock).toMatch(/top:\s*var\(--app-interactive-safe-top/)
    expect(customCssDock).not.toMatch(/data-tauri-desktop|display-mode:\s*window-controls-overlay/)

    expect(spindleDock).toMatch(
      /\.left\s*\{[\s\S]*?top:\s*var\(--app-interactive-safe-top/,
    )
    expect(spindleDock).toMatch(
      /\.right\s*\{[\s\S]*?top:\s*var\(--app-interactive-safe-top/,
    )
    expect(spindleDock).toMatch(
      /\.top\s*\{[\s\S]*?top:\s*var\(--app-interactive-safe-top/,
    )
    expect(spindleDock).not.toMatch(/data-tauri-desktop|display-mode:\s*window-controls-overlay/)
  })

  test('caps rendered vertical docks without rewriting extension preferences', () => {
    expect(resetCss).toMatch(/--app-interactive-viewport-height:\s*max\(/)
    expect(spindleDock).toMatch(
      /\.top,\s*\n\.bottom\s*\{[\s\S]*?max-height:\s*var\(\s*--app-interactive-viewport-height/,
    )
    expect(spindleDockComponent).toContain(
      '{ height: isMobile ? Math.min(currentSize, window.innerHeight * 0.6) : currentSize }',
    )
  })

  test('keeps built-in application surfaces below the window chrome layer', async () => {
    const chromeZ = Number(resetCss.match(/--app-window-chrome-z-index:\s*(\d+)/)?.[1])
    expect(chromeZ).toBeGreaterThan(0)
    expect(titlebarCss).toMatch(/z-index:\s*var\(--app-window-chrome-z-index/)

    const sourceRoot = resolve(import.meta.dir, '../..')
    const glob = new Bun.Glob('**/*.{css,tsx}')
    const violations: string[] = []

    for await (const path of glob.scan({ cwd: sourceRoot, onlyFiles: true })) {
      if (path.endsWith('ConnectionLostOverlay.module.css')) continue
      const source = await Bun.file(resolve(sourceRoot, path)).text()
      const values = [
        ...source.matchAll(/(?:^|\n)\s*z-index:\s*(\d+)/g),
        ...source.matchAll(/\bzIndex\s*[:=]\s*\{?(\d+)/g),
      ].map((match) => Number(match[1]))
      if (values.some((value) => value >= chromeZ)) violations.push(path)
    }

    expect(violations).toEqual([])
  })
})
