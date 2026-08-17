import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const chatDir = import.meta.dir
const sourceDir = resolve(chatDir, '../..')

const readSource = (file: string) => Bun.file(resolve(chatDir, file)).text()
const countMatches = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0

function mountTags(source: string, mount: string): string[] {
  const escapedMount = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`<[^>]*data-spindle-mount=["']${escapedMount}["'][^>]*>`, 'g')) ?? []
}

describe('P12 chat dock preservation contracts', () => {
  test('keeps ChatView DOM mount anchors total and distinct', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toContain('data-component="ChatView"')
    for (const mount of ['chat_column_top', 'chat_top_dock', 'chat_bottom_dock', 'lorebook_half_workspace', 'chat_surface_side']) {
      const tags = mountTags(source, mount)
      expect(tags, mount).toHaveLength(1)
      expect(tags[0]).toMatch(/^\s*<\w+/)
    }

    expect(source).toMatch(
      /data-spindle-mount=["']chat_top_dock["'][^>]*data-dock-request=["']floating["']/,
    )
  })

  test('keeps ChatView occupancy, literal dock requests, and top-height plumbing local to generic DOM refs', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toContain("from '@/lib/chatSurfaceLayout'")
    expect(source).toMatch(/syncDockRequest\(\s*chatColumnTop\s*,\s*chatTopDockMode\s*\)/)
    expect(source).toMatch(/syncDockRequest\(\s*chatTopDock\s*,\s*chatTopDockMode\s*\)/)
    expect(source).toMatch(/syncDockRequest\(\s*composerAbove\s*,\s*chatLoreDockMode\s*\)/)
    expect(source).toContain('data-dock-request')
    expect(source).toContain('data-spindle-occupied')
    expect(source).toContain('findExtensionChild')

    const findExtensionChild = source.match(
      /function findExtensionChild\(anchor: HTMLElement\): Element \| null \{[\s\S]*?return null\s*\}/,
    )?.[0] ?? ''
    expect(findExtensionChild).toMatch(/for\s*\(const child of anchor\.children\)/)
    expect(findExtensionChild).toMatch(/child\.hasAttribute\(\s*['"]data-spindle-extension-root['"]\s*\)/)
    expect(findExtensionChild).toMatch(/child\.hasAttribute\(\s*['"]data-spindle-ext['"]\s*\)/)
    expect(findExtensionChild).toMatch(/child\.children\.length\s*>\s*0/)
    expect(findExtensionChild).toMatch(/child\.textContent\?\.trim\(\)/)
    expect(findExtensionChild).toMatch(/marked\s*&&\s*hasMountedContent/)

    expect(source).toMatch(/data-spindle-extension-root[\s\S]{0,120}data-spindle-ext/)
    expect(source).toMatch(/findExtensionChild\(anchor\)[\s\S]{0,120}data-spindle-occupied/)
    expect(source).toMatch(/(?:setAttribute|toggleAttribute)\([\s\S]{0,120}data-spindle-occupied/)
    expect(source).toMatch(/(?:removeAttribute|toggleAttribute)\([\s\S]{0,120}data-spindle-occupied/)
    expect(source).toContain('new MutationObserver')
    expect(source).toContain('new ResizeObserver')
    expect(source).toContain('measureLayoutHeight(chatTopDock)')
    expect(source).toMatch(/setProperty\(\s*["']--lcs-top-dock-height["']/)
    expect(source).toMatch(/document\.documentElement[\s\S]{0,160}attributeFilter:\s*\['style'\]/)
    expect(source).not.toMatch(/from\s+["'][^"']*(?:suite|spindle\/suite)[^"']*["']/i)
  })

  test('publishes composer and input safe zones through one ResizeObserver path', async () => {
    const source = await readSource('InputArea.tsx')

    expect(source).toMatch(
      /import\s+\{[^}]*composeChatSafeZones[^}]*\}\s+from\s+["']@\/lib\/chatSurfaceLayout["']/s,
    )
    expect(countMatches(source, /new\s+ResizeObserver\s*\(/g)).toBe(1)
    expect(source).toContain('composeChatSafeZones')
    expect(source).toMatch(/setProperty\(\s*["']--lcs-composer-safe-zone["']/)
    expect(source).toMatch(/setProperty\(\s*["']--lcs-input-safe-zone["']/)
    expect(source).toMatch(/composeChatSafeZones\(\s*composerHeight\s*,\s*loreHeight\s*,\s*bottomOffset\s*\)/)

    expect(source).toContain('ro.observe(el)')
    expect(source).toContain('ro.observe(loreMount)')
    expect(source).toContain('ro.disconnect()')
    expect(source).toMatch(/data-spindle-mount=["']chat_composer_above["']/)
    expect(source).toContain('--app-keyboard-inset-bottom')
    expect(source).toContain('renderedPxToLayoutPx(child.getBoundingClientRect().height)')
    expect(source).toMatch(/rootObserver\.observe\(root,[\s\S]{0,100}attributeFilter:\s*\['style'\]/)

    const hiddenEditPath = source.match(/if \(!hideForMobileEdit\) return[\s\S]*?\}, \[hideForMobileEdit\]\)/s)?.[0] ?? ''
    expect(hiddenEditPath).toContain('composeChatSafeZones')
    expect(hiddenEditPath).toContain('--lcs-composer-safe-zone')
    expect(hiddenEditPath).toContain('--lcs-input-safe-zone')
  })

  test('preserves claimed and unclaimed H9 fallback behavior for native and message avatars', async () => {
    const portrait = await readSource('PortraitPanel.tsx')
    const bubble = await readSource('BubbleMessageDefault.tsx')
    const minimal = await readSource('MinimalMessageDefault.tsx')

    expect(countMatches(portrait, /requestHostIntent\(\s*["']image-preview["']/g)).toBe(2)
    expect(portrait).toMatch(/source:\s*["']portrait-frame["'][\s\S]{0,220}setLightboxSrc\(imageUrl\)/)
    expect(portrait).toMatch(/source:\s*["']portrait-gallery["'][\s\S]{0,220}setLightboxSrc\(imageUrl\)/)
    expect(portrait).toMatch(/(?:requestHostIntent\([\s\S]*?\)\s*\))\s*return/)

    for (const [name, source, sourceTag] of [
      ['bubble', bubble, 'bubble-message-avatar'],
      ['minimal', minimal, 'minimal-message-avatar'],
    ] as const) {
      expect(countMatches(source, /requestHostIntent\(\s*["']image-preview["']/g), name).toBe(1)
      expect(source).toMatch(
        new RegExp(`if\\s*\\(\\s*!requestHostIntent\\([\\s\\S]{0,220}source:\\s*["']${sourceTag}["'][\\s\\S]{0,180}openFloatingAvatar\\(`),
      )
      expect(source).toContain("displayName?.[0]?.toUpperCase() || '?'")
    }

    expect(portrait).toContain("(charName || '?')[0].toUpperCase()")
  })

  test('does not publish the removed chat bottom inset variable anywhere in frontend/src', async () => {
    const paths: string[] = []
    const glob = new Bun.Glob('**/*.{ts,tsx,js,jsx,css,scss,html}')
    for await (const path of glob.scan({ cwd: sourceDir, onlyFiles: true })) paths.push(path)

    const source = (await Promise.all(paths.map((path) => Bun.file(resolve(sourceDir, path)).text()))).join('\n')
    const removedVariable = ['--lcs-chat', 'bottom-inset'].join('-')
    expect(source).not.toContain(removedVariable)
  })

  test('keeps lore dock hit testing limited to real controls', async () => {
    const css = await readSource('ChatView.module.css')
    expect(css).toMatch(/data-surface-id='activated_lore\.indicator'[\s\S]{0,260}pointer-events:\s*none/)
    expect(css).toMatch(/data-surface-id='activated_lore\.panel'[\s\S]{0,260}pointer-events:\s*none/)
    expect(css).toContain("[data-spindle-host-surface] > [data-surface-id='activated_lore.indicator']")
    expect(css).toMatch(/data-surface-id='activated_lore\.indicator'] \*\)\s*,[\s\S]{0,180}pointer-events:\s*auto/)

    const host = await Bun.file(resolve(sourceDir, 'lib/spindle/productivity-host-contracts.tsx')).text()
    expect(host).not.toContain('Activated lore details')
    expect(host).not.toContain('Close activated lore details')
    expect(host).toContain('const stateKey = useMemo(() => JSON.stringify(state ?? null), [state])')
    expect(host).toMatch(/syncCanonicalSettings\(surfaceId, stateRef\.current\)[\s\S]{0,80}\[surfaceId, stateKey\]/)
  })

  test('flattens the half-editor host wrapper into the chat flex row', async () => {
    const css = await readSource('ChatView.module.css')
    const editorCss = await readSource('../world-book-editor/LorebookHalfScreenEditor.module.css')

    expect(css).toContain(
      ":global([data-spindle-mount='lorebook_half_workspace'] > [data-spindle-extension-root] > [data-spindle-host-surface='lorebook.half.workspace'])",
    )
    expect(css).toMatch(/data-spindle-host-surface='lorebook\.half\.workspace'\]\)\s*\{\s*display:\s*contents;/)
    expect(editorCss).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.halfScreenHost\s*\{[^}]*flex:\s*0 0 100%;[^}]*height:\s*100%;[^}]*max-height:\s*100%;/)
    expect(editorCss).toMatch(/\.halfScreenHost\[data-force-half-screen='true'\]\s*\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*100%;/)
  })

  test('gives a strip-mounted Quick Toolbar the remaining top-dock width', async () => {
    const css = await readSource('ChatView.module.css')
    const stripChain = css.match(
      /\[data-spindle-mount='chat_top_dock'\][\s\S]{0,1000}data-surface-id='quick_toolbar\.workspace'[\s\S]{0,320}\}/,
    )?.[0] ?? ''

    expect(stripChain).toContain("[data-dock-request='strip']")
    expect(stripChain).toContain("[data-spindle-host-surface]")
    expect(stripChain).toContain('flex: 1 1 auto;')
    expect(stripChain).toContain('min-width: 0;')
    expect(stripChain).toContain('max-width: 100%;')
  })

  test('keeps the sparse strip rail centered while Select Messages stays at the right edge', async () => {
    const chatCss = await readSource('ChatView.module.css')
    const toolbarCss = await readSource('../quick-toolbar/QuickToolbar.module.css')

    expect(chatCss).toMatch(/\.chatToolbar\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?padding:\s*6px 8px;[\s\S]*?gap:\s*6px;/)
    expect(chatCss).toMatch(/\.toolbarBtn\s*\{[\s\S]*?order:\s*0;/)
    expect(chatCss).not.toMatch(/\.toolbarBtn\s*\{[\s\S]*?margin-left:\s*auto;/)
    expect(toolbarCss).toMatch(/\.cardStrip\s*\{[^}]*?justify-content:\s*center;/)
  })
})
