import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./productivity-host-contracts.tsx', import.meta.url)).text()

describe('enhanced lorebook workspace fullscreen contract', () => {
  test('uses the configured desktop launch mode, forces mobile fullscreen, and keeps the toggle available', () => {
    expect(source).toContain("viewport.width <= MOBILE_EDITOR_MAX_WIDTH || settings.fullEditorLaunchMode === 'fullscreen'")
    expect(source).toContain('rect={fullscreen ? viewport : rect}')
    expect(source).toContain('resizable={!fullscreen}')
    expect(source).toContain('onToggleFullscreen={() => setFullscreen((current) => {')
    expect(source).toContain('setRect(resolveWindowedEditorRect(')
    expect(source).toContain('if (viewport.width <= MOBILE_EDITOR_MAX_WIDTH) return')
    expect(source).toContain('aria-label="Full-Screen Lorebook Editor"')
  })
})
