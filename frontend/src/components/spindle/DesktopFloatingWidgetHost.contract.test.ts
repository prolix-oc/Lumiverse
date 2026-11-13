import { describe, expect, test } from 'bun:test'

const widgetHost = await Bun.file(new URL('./DesktopFloatingWidgetHost.tsx', import.meta.url)).text()
const desktopFrontend = await Bun.file(
  new URL('../../../../desktop/src-tauri/src/frontend.rs', import.meta.url),
).text()

describe('desktop floating widget interaction contract', () => {
  test('focuses an inactive widget before starting native drag operations', () => {
    const focusCapture = widgetHost.indexOf('onPointerDownCapture=')
    const setFocus = widgetHost.indexOf('nativeWindow.setFocus()', focusCapture)
    const startDragging = widgetHost.indexOf('nativeWindow.startDragging()', focusCapture)
    const startResizeDragging = widgetHost.indexOf('nativeWindow.startResizeDragging(', focusCapture)

    expect(focusCapture).toBeGreaterThan(-1)
    expect(setFocus).toBeGreaterThan(focusCapture)
    expect(startDragging).toBeGreaterThan(setFocus)
    expect(startResizeDragging).toBeGreaterThan(setFocus)
  })

  test('retains native first-mouse delivery for inactive macOS widgets', () => {
    expect(desktopFrontend).toMatch(
      /\.focused\(false\)[\s\S]*?\.accept_first_mouse\(true\)[\s\S]*?\.focusable\(true\)/,
    )
  })
})
