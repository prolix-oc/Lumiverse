import { describe, expect, test } from 'bun:test'

const entriesSource = await Bun.file(new URL('./WorldBookEntriesSection.tsx', import.meta.url)).text()
const panelStyles = await Bun.file(
  new URL('../panels/world-book/WorldBookPanel.module.css', import.meta.url),
).text()

describe('Android PWA lorebook field focus contract', () => {
  test('defers to the browser-resized viewport and performs one settled fallback', () => {
    expect(entriesSource).toContain("root.hasAttribute('data-pwa') && root.hasAttribute('data-resizes-content')")
    expect(entriesSource).toContain('ENTRY_FIELD_RESIZED_VIEWPORT_SETTLE_DELAY')
    expect(entriesSource).toContain('focusRevealTimersRef.current = [window.setTimeout(')
    expect(entriesSource).toContain('if (usesBrowserResizedKeyboardViewport()) return')
  })

  test('does not count the keyboard inset twice in the Android PWA panel', () => {
    expect(panelStyles).toContain(':global(html[data-pwa][data-resizes-content]) .panelScroll')
    expect(panelStyles).toContain('scroll-padding-block: 12px calc(12px + var(--worldbook-footer-height, 0px));')
    expect(panelStyles).toContain(':global(html[data-pwa][data-resizes-content]) .panelBody')
    expect(panelStyles).toContain('padding-bottom: calc(12px + var(--worldbook-footer-height, 0px));')
  })

  test('keeps the negative keyboard footer correction exclusive to iOS', () => {
    expect(panelStyles).not.toContain(':global(html[data-resizes-content]) .panelFooter')
    expect(panelStyles).toContain(':global(html[data-ios-pwa]) .panelFooter')
  })
})
