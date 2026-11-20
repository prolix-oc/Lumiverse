import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./ProductivitySettings.tsx', import.meta.url)).text()
const defaults = await Bun.file(new URL('../../lib/uiProductivityDefaults.ts', import.meta.url)).text()

describe('Lorebook full editor launch preference', () => {
  test('defaults to windowed and exposes both launch modes in Productivity settings', () => {
    expect(defaults).toContain("fullEditorLaunchMode: 'windowed'")
    expect(source).toContain('label="Full editor launch"')
    expect(source).toContain("[['windowed', 'Windowed'], ['fullscreen', 'Full screen']]")
    expect(source).toContain("update('lorebookEditorSettings', { fullEditorLaunchMode })")
  })
})
