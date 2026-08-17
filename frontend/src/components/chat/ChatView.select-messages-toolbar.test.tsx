import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { isShowNativeSelectMessages } from '../quick-toolbar/quickToolbarDock'

describe('ChatView native select-messages toolbar', () => {
  test('isShowNativeSelectMessages stays on unless explicitly false', () => {
    expect(isShowNativeSelectMessages(undefined)).toBe(true)
    expect(isShowNativeSelectMessages({})).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: true })).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: false })).toBe(false)
  })

  test('ChatView gates only ListChecks with the helper and keeps MessageSelectBar', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()

    expect(source).toContain("import { isShowNativeSelectMessages, readQuickToolbarPlacement } from '../quick-toolbar/quickToolbarDock'")
    expect(source).toContain('ListChecks')
    expect(source).toMatch(/isShowNativeSelectMessages\(quickToolbarSettings\)\s*&&\s*\(/)
    expect(source).toMatch(/aria-pressed=\{messageSelectMode\}/)
    expect(source).toMatch(/\{messageSelectMode && <MessageSelectBar chatId=\{chatId\} \/>\}/)

    const nativeButton = source.match(
      /\{isShowNativeSelectMessages\(quickToolbarSettings\) && \([\s\S]*?<ListChecks size=\{14\} \/>[\s\S]*?<\/button>\s*\)\}/,
    )?.[0] ?? ''
    expect(nativeButton).toContain('aria-pressed={messageSelectMode}')
    expect(nativeButton).toContain('ListChecks')
    expect(nativeButton).not.toContain('MessageSelectBar')

    const selectBarIndex = source.indexOf('{messageSelectMode && <MessageSelectBar chatId={chatId} />}')
    const gateIndex = source.indexOf('isShowNativeSelectMessages(quickToolbarSettings)')
    expect(selectBarIndex).toBeGreaterThan(gateIndex)
    expect(source.slice(gateIndex, selectBarIndex)).toContain('</button>')
  })
})
