import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { effectiveQuickToolbarDockRequest } from '@/lib/chatSurfaceLayout'

const chatDir = import.meta.dir
const sourceDir = resolve(chatDir, '../..')

const readSource = (file: string) => Bun.file(resolve(chatDir, file)).text()
const countMatches = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0

function mountTags(source: string, mount: string): string[] {
  const escapedMount = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`<[^>]*data-spindle-mount=["']${escapedMount}["'][^>]*>`, 'g')) ?? []
}

describe('P12 chat dock preservation contracts', () => {
  test('uses one retained Quick Toolbar request predicate for dock, retained float, and hidden float', () => {
    expect(effectiveQuickToolbarDockRequest('strip', {
      quickToolbarPlacement: 'chat_top_dock',
      hideInChatTopDock: true,
    })).toBe('strip')
    expect(effectiveQuickToolbarDockRequest('strip', {
      quickToolbarPlacement: 'floating',
      hideInChatTopDock: false,
    })).toBe('strip')
    expect(effectiveQuickToolbarDockRequest('strip', {
      quickToolbarPlacement: 'floating',
      hideInChatTopDock: true,
    })).toBe('floating')
    expect(effectiveQuickToolbarDockRequest('floating', {
      quickToolbarPlacement: 'chat_top_dock',
      hideInChatTopDock: false,
    })).toBe('floating')
  })

  test('keeps ChatView DOM mount anchors total and distinct', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toContain('data-component="ChatView"')
    for (const mount of ['chat_column_top', 'chat_top_dock', 'chat_bottom_dock', 'lorebook_half_workspace', 'chat_surface_side']) {
      const tags = mountTags(source, mount)
      expect(tags, mount).toHaveLength(1)
      expect(tags[0]).toMatch(/^\s*<\w+/)
    }

    expect(source).toContain('data-dock-request={chatTopDockRequest}')
    expect(source).toContain('{dockQuickToolbar && <QuickToolbar />}')
  })

  test('keeps ChatView occupancy, literal dock requests, and top-height plumbing local to generic DOM refs', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toContain("from '@/lib/chatSurfaceLayout'")
    expect(source).toContain('effectiveQuickToolbarDockRequest')
    expect(source).toMatch(/syncDockRequest\(\s*chatColumnTop\s*,\s*\(request\)\s*=>\s*effectiveQuickToolbarDockRequest/)
    expect(source).toMatch(/syncDockRequest\(\s*chatTopDock\s*,\s*\(\)\s*=>\s*nativeDockRequest\s*,\s*nativeDockRequest\s*,\s*\(request\)\s*=>\s*effectiveQuickToolbarDockRequest/)
    expect(source).toMatch(/const child = findExtensionChild\(anchor\)/)
    expect(source).toMatch(/child\.getAttribute\(['"]data-dock-request['"]\)/)
    expect(source).toContain("child.setAttribute('data-dock-request', childRequest)")
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
    expect(findExtensionChild).toMatch(/contentRoot\.children\.length\s*>\s*0/)
    expect(findExtensionChild).toMatch(/child\.querySelector<HTMLElement>\(/)
    expect(findExtensionChild).toContain('[data-surface-id]')
    expect(findExtensionChild).toMatch(/contentRoot\.children\.length\s*>\s*0/)
    expect(findExtensionChild).toMatch(/contentRoot\.textContent\?\.trim\(\)/)
    expect(findExtensionChild).toMatch(/marked\s*&&\s*hasMountedContent/)

    expect(source).toMatch(/data-spindle-extension-root[\s\S]{0,120}data-spindle-ext/)
    expect(source).toMatch(/findExtensionChild\(anchor\)[\s\S]{0,120}data-spindle-occupied/)
    expect(source).toMatch(/(?:setAttribute|toggleAttribute)\([\s\S]{0,120}data-spindle-occupied/)
    expect(source).toMatch(/(?:removeAttribute|toggleAttribute)\([\s\S]{0,120}data-spindle-occupied/)
    expect(source).toContain('new MutationObserver')
    expect(source).toContain('new ResizeObserver')
    expect(source).toContain('measureLayoutHeight(chatTopDock)')
    expect(source).toMatch(/setProperty\(\s*["']--lcs-top-dock-height["']/)
    expect(source).toMatch(/const syncTopDockHeight = \(\) => \{\s*const height = measureLayoutHeight\(chatTopDock\)/)
    expect(source).not.toMatch(/const syncTopDockHeight = \(\) => \{\s*const height = findExtensionChild\(chatTopDock\) \? measureLayoutHeight\(chatTopDock\) : 0/)
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

  test('keeps the scroll shortcut clear of the composer with its own contrast pair', async () => {
    const css = await readSource('ScrollToBottom.module.css')

    expect(css).toMatch(/bottom:\s*calc\(var\(--lcs-input-safe-zone, 100px\) \+ 8px\)/)
    expect(css).toContain('background: var(--lumiverse-primary-deep')
    expect(css).toContain('color: var(--lumiverse-primary-deep-contrast')
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
    expect(chatCss).not.toMatch(/\.toolbarBtn\s*\{[^}]*?margin-left:\s*auto;/)
    expect(toolbarCss).toMatch(/\.cardStrip\s*\{[^}]*?justify-content:\s*center;/)
  })

  test('keeps the chat top dock as a stable host while toolbar wrappers are empty or pending', async () => {
    const css = await readSource('ChatView.module.css')

    expect(css).toContain(".chatToolbar[data-dock-request='strip']")
    expect(css).toContain(".chatToolbar[data-spindle-occupied]")
    const occupiedStripSelector = ".chatToolbar[data-dock-request='strip']"
    const occupiedStripStart = css.indexOf(occupiedStripSelector)
    const occupiedStripRule = css.slice(occupiedStripStart, css.indexOf('}', occupiedStripStart) + 1)
    expect(occupiedStripRule).toMatch(/min-height:\s*41px;/)
    expect(css).not.toMatch(/\.chatToolbar\s*\{[^}]*?min-height:\s*41px;/)
    expect(css).toContain('Empty spindle wrappers must not collapse the host-owned top-dock rail or create a visible second rail.')
    expect(css).toMatch(/quick_toolbar\.workspace'\]:not\(:has\(\*\)\)[\s\S]*?display:\s*contents;/)
    expect(css).not.toMatch(/quick_toolbar\.workspace'\]:not\(:has\(\*\)\)[\s\S]{0,320}height:\s*0\s*!important;/)
  })

  test('suppresses the transient blank rail when a retained dock surface is empty and floating', async () => {
    const css = await readSource('ChatView.module.css')

    expect(css).toMatch(/\.chatToolbar\[data-dock-request='floating'\]:not\(:has\(> button:not\(\[hidden\]\), > \.nativeDockActions > button:not\(\[hidden\]\), > \[data-component='QuickToolbar'\]\)\):not\(\[data-spindle-occupied\]\)[\s\S]*?display:\s*contents;/)
    expect(css).toMatch(/data-surface-id='quick_toolbar\.workspace'\]:not\(:has\(\*\)\)[\s\S]*?display:\s*contents;/)
  })

  test('keeps docked cards inside the rail while trailing controls keep their space', async () => {
    const toolbarCss = await readSource('../quick-toolbar/QuickToolbar.module.css')

    expect(toolbarCss).toMatch(/\.cardScroller\s*\{[^}]*?min-width:\s*0;[^}]*?max-width:\s*100%;[^}]*?flex:\s*1 1 auto;[^}]*?overflow:\s*hidden;/)
    expect(toolbarCss).toMatch(/\.root(?:Anchored)?\[data-quick-toolbar-placement='chat_top_dock'\](?:\[data-fill-top-dock='1'\]|:not\(\[data-fill-top-dock='0'\]\))\s+\.cardStrip\s*\{[^}]*?width:\s*100%;[^}]*?flex:\s*1 1 auto;/)
  })

  test('expands fill-mode cards proportionally while the rail strip consumes slack', async () => {
    const toolbarCss = await readSource('../quick-toolbar/QuickToolbar.module.css')

    expect(toolbarCss).toContain(".root[data-fill-screen='1'] .cardSlot")
    expect(toolbarCss).toContain(".root[data-fill-top-dock='1'] .cardSlot")
    const cardSlotRules = toolbarCss.slice(toolbarCss.indexOf(".root[data-fill-screen='1'] .cardSlot"), toolbarCss.indexOf('}', toolbarCss.indexOf(".root[data-fill-screen='1'] .cardSlot")) + 1)
    expect(cardSlotRules).toMatch(/flex:\s*1 1 0px !important;/)
    const dockCardSlotRules = toolbarCss.slice(toolbarCss.indexOf(".root[data-fill-top-dock='1'] .cardSlot"), toolbarCss.indexOf('}', toolbarCss.indexOf(".root[data-fill-top-dock='1'] .cardSlot")) + 1)
    expect(dockCardSlotRules).toMatch(/flex:\s*1 1 0px !important;/)
    expect(toolbarCss).toContain(".root[data-fill-screen='1'] .cardSlot .card")
    expect(toolbarCss).toContain(".root[data-fill-top-dock='1'] .cardSlot .card")
    expect(toolbarCss).toContain('width: var(--quick-toolbar-card-width, 100%) !important;')
    const fillDockSelector = ".root[data-quick-toolbar-placement='chat_top_dock'][data-fill-top-dock='1'] .cardStrip"
    expect(toolbarCss).toContain(fillDockSelector)
    const fillDockStart = toolbarCss.indexOf(fillDockSelector)
    const fillDockRule = toolbarCss.slice(fillDockStart, toolbarCss.indexOf('}', fillDockStart) + 1)
    expect(fillDockRule).toMatch(/width:\s*100%;/)
    expect(fillDockRule).toMatch(/flex:\s*1 1 auto;/)
  })

  test('enforces unconditional 100% stretch on chatToolbar QuickToolbar and bans max-content clamp', async () => {
    const chatCss = await readSource('./ChatView.module.css')

    // Must never clamp data-fill-top-dock='0' to max-content (which causes 71px-151px trailing dead space)
    expect(chatCss).not.toMatch(/data-fill-top-dock='0'\][\s\S]*?width:\s*max-content/)
    expect(chatCss).not.toMatch(/data-fill-top-dock='0'\][\s\S]*?flex:\s*0 0 auto/)

    // Must stretch QuickToolbar to 100% width across the docker
    expect(chatCss).toMatch(/\.chatToolbar > :global\(\[data-component='QuickToolbar'\]\[data-quick-toolbar-placement='chat_top_dock'\]\)[\s\S]*?flex:\s*1 1 100% !important;[\s\S]*?width:\s*100% !important;/)
  })

  test('enforces snug card padding and gap with zero internal dead space in docked V2', async () => {
    const toolbarCss = await readSource('../quick-toolbar/QuickToolbar.module.css')

    expect(toolbarCss).toMatch(/\.rootAnchored\[data-quick-toolbar-placement='chat_top_dock'\]\[data-quick-toolbar-variant='v2'\] \.cardSlot \.card[\s\S]*?padding:\s*2px 6px !important;/)
    expect(toolbarCss).toMatch(/\.rootAnchored\[data-quick-toolbar-placement='chat_top_dock'\]\[data-quick-toolbar-variant='v2'\] \.cardSlot \.card[\s\S]*?gap:\s*4px !important;/)
  })

  test('enforces symmetrical centering on docked V1 Free in chatToolbar and bans flex-start lock', async () => {
    const chatCss = await readSource('./ChatView.module.css')
    const toolbarCss = await readSource('../quick-toolbar/QuickToolbar.module.css')

    // V1 in chatToolbar must be centered and expand symmetrically
    expect(chatCss).toMatch(/\.chatToolbar > :global\(\[data-component='QuickToolbar'\]\[data-quick-toolbar-placement='chat_top_dock'\]\[data-quick-toolbar-variant='v1'\]\) > nav[\s\S]*?margin-inline:\s*auto !important;[\s\S]*?justify-content:\s*center !important;/)
    expect(chatCss).not.toMatch(/\.chatToolbar > :global\(\[data-component='QuickToolbar'\]\[data-quick-toolbar-placement='chat_top_dock'\]\[data-quick-toolbar-variant='v1'\]\) > nav[\s\S]*?justify-content:\s*flex-start/)

    // V1 rootAnchored must center its horizontal pill as a unit
    expect(toolbarCss).toMatch(/\.rootAnchored\[data-quick-toolbar-variant='v1'\]\s*\{[\s\S]*?justify-content:\s*center;/)
    expect(toolbarCss).toMatch(/\.rootAnchored\[data-quick-toolbar-variant='v1'\] \.toolbarHorizontal\s*\{[\s\S]*?margin-inline:\s*auto;[\s\S]*?justify-content:\s*center;/)
  })

  test('keeps native top dock strip independent of QuickToolbar placement', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toContain("const nativeDockRequest = 'strip' as const")
    // Line-anchored: the rail's own request must be the native constant and
    // nothing else. A placement-derived tail (dockQuickToolbar /
    // keepFloatingDockHost / effectiveQuickToolbarDockRequest) would let Suite
    // placement move or collapse the native strip, which is the regression this
    // contract exists to prevent.
    expect(source).toMatch(/^\s*const chatTopDockRequest = nativeDockRequest\s*$/m)
    expect(source).toMatch(/data-dock-request=\{chatTopDockRequest\}/)
    expect(source).toMatch(/syncDockRequest\(\s*chatTopDock\s*,\s*\(\)\s*=>\s*nativeDockRequest\s*,\s*nativeDockRequest\s*,\s*\(request\)\s*=>\s*effectiveQuickToolbarDockRequest\(request,\s*quickToolbarSettings\)\s*\)/)
  })

  test('publishes the measured top-dock height from the shared chat body ref with matching cleanup', async () => {
    const source = await readSource('ChatView.tsx')

    expect(source).toMatch(/const chatBodyRef = useRef<HTMLDivElement>\(null\)/)
    expect(source).toMatch(/const chatBody = chatBodyRef\.current/)
    expect(source).toMatch(/if \(!chatBody \|\| !chatColumnInner \|\| !chatColumnTop \|\| !chatTopDock\) return/)
    expect(source).toMatch(/<div ref=\{chatBodyRef\} className=\{styles\.body\}/)

    // Publisher and cleanup must both target the body ref, never the inner column.
    expect(source).toMatch(/chatBody\.style\.setProperty\(\s*["']--lcs-top-dock-height["']/)
    expect(source).toMatch(/chatBody\.style\.removeProperty\(\s*["']--lcs-top-dock-height["']\s*\)/)
    expect(source).not.toMatch(/chatColumnInner\.style\.(?:set|remove)Property\(\s*["']--lcs-top-dock-height["']/)

    // The measurement source stays the dock ref itself.
    expect(source).toMatch(/const syncTopDockHeight = \(\) => \{\s*const height = measureLayoutHeight\(chatTopDock\)/)
  })

  test('reserves the fixed fill dock strip on the shared body row only, bounded to the viewport', async () => {
    const css = await readSource('./ChatView.module.css')
    const fillBodySelector = ".body:has(.chatToolbar [data-component='QuickToolbar'][data-fill-top-dock='1'])"

    const bodyStart = css.indexOf(fillBodySelector)
    expect(bodyStart).toBeGreaterThan(-1)
    const bodyRule = css.slice(bodyStart, css.indexOf('}', bodyStart) + 1)
    expect(bodyRule).toMatch(/box-sizing:\s*border-box;/)
    expect(bodyRule).toMatch(/height:\s*100%;/)
    expect(bodyRule).toMatch(/padding-top:\s*var\(--lcs-top-dock-height,\s*41px\);/)

    // The fill-only reservation must not be duplicated on the inner column, and
    // must not leak onto any non-fill body state.
    expect(css).not.toMatch(/\n\.chatColumnInner:has\(\.chatToolbar[^{}]*\)\s*\{[^}]*padding-top:\s*var\(--lcs-top-dock-height,\s*41px\);/)
    expect(css).not.toMatch(/\n\.body:has\([^{}]*\):has\([^{}]*\)\s*\{[^}]*padding-top:\s*var\(--lcs-top-dock-height/)
    expect(css).not.toMatch(/\n\.body\s*\{[^}]*padding-top:\s*var\(--lcs-top-dock-height/)
  })

  test('raises the half-editor host above the fill dock strip on desktop only', async () => {
    const css = await readSource('./ChatView.module.css')

    expect(css).toMatch(
      /@media \(min-width: 769px\) \{[\s\S]{0,600}?\.body:has\(\.chatToolbar \[data-component='QuickToolbar'\]\[data-fill-top-dock='1'\]\)[\s\S]{0,500}?\[data-spindle-host-surface='lorebook\.half\.workspace'\]\)[\s\S]{0,220}?\[data-component='LorebookHalfScreenEditor'\]\) \{[^}]*z-index:\s*10000;/,
    )

    // The rung is the fill dock's nearest ceiling, and must stay off the toolbar,
    // the shared body, and every higher layer that already owns its own numbering.
    const desktopStart = css.indexOf('@media (min-width: 769px)')
    const desktopRule = css.slice(desktopStart, css.indexOf('@media (max-width: 600px)', desktopStart))
    expect(desktopRule).not.toMatch(/\n\.chatToolbar\s*\{[^}]*z-index/)
    expect(desktopRule).not.toMatch(/\n\.body\s*\{[^}]*z-index/)
    expect(desktopRule).not.toMatch(/z-index:\s*10001/)
    expect(desktopRule).not.toMatch(/z-index:\s*10005/)
    expect(desktopRule).not.toMatch(/z-index:\s*10006/)
    expect(desktopRule).not.toMatch(/z-index:\s*10010/)
  })

  test('keeps the fill dock strip and the mobile/floating half-editor rungs unchanged', async () => {
    const css = await readSource('./ChatView.module.css')
    const fillStart = css.indexOf(".chatToolbar:has([data-component='QuickToolbar'][data-fill-top-dock='1'])")
    const fillRule = css.slice(fillStart, css.indexOf('}', fillStart) + 1)

    expect(fillRule).toMatch(/position:\s*fixed !important;/)
    expect(fillRule).toMatch(/top:\s*0 !important;/)
    expect(fillRule).toMatch(/left:\s*0 !important;/)
    expect(fillRule).toMatch(/width:\s*100% !important;/)
    expect(fillRule).toMatch(/z-index:\s*9999 !important;/)

    const editorCss = await readSource('../world-book-editor/LorebookHalfScreenEditor.module.css')
    expect(editorCss).toMatch(/\.halfScreenHost\[data-layout='overlay'\]\s*\{/)
    expect(countMatches(editorCss, /z-index:\s*10006;/g)).toBeGreaterThan(0)
    expect(editorCss).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.halfScreenHost\s*\{[^}]*z-index:\s*10006;/)
  })

  test('contracts the notice docks against the fixed fill rail instead of consuming the dock height', async () => {
    const css = await readSource('./ChatView.module.css')

    const desktopStart = css.indexOf('.noticeDock,')
    const desktopRule = css.slice(desktopStart, css.indexOf('}', desktopStart) + 1)
    const mobileStart = css.indexOf('@media (max-width: 600px)')
    const mobileRule = css.slice(css.indexOf('.noticeDock,', mobileStart))
    const mobileBlock = mobileRule.slice(0, mobileRule.indexOf('}') + 1)

    // Exactly two grouped notice rules, each anchored to its own literal offset.
    // `\s*` spans the CRLF pairs in this stylesheet, which a literal `\n` would not.
    expect(countMatches(css, /\.noticeDock,\s*\.cortexNoticeDock\s*\{/g)).toBe(2)
    expect(desktopRule).toMatch(/top:\s*48px;/)
    expect(mobileBlock).toMatch(/top:\s*54px;/)

    // Neither may consume the dock height: on the shared body it now resolves there,
    // so the notice would shift without the fill dock and double-displace with it.
    expect(desktopRule).not.toContain('--lcs-top-dock-height')
    expect(mobileBlock).not.toContain('--lcs-top-dock-height')

    // Exactly one dock-height consumer remains anywhere in the stylesheet.
    expect(countMatches(css, /var\(--lcs-top-dock-height/g)).toBe(1)
    expect(css).toMatch(/\n\.body:has\(\.chatToolbar [^{}]*\)\s*\{[^}]*padding-top:\s*var\(--lcs-top-dock-height/)
  })

  test('enforces strip dockrail min-height and prevents display:contents on data-dock-request=strip', async () => {
    const chatCss = await readSource('./ChatView.module.css')

    // Strip dock must always retain min-height 41px and never collapse via display: contents
    expect(chatCss).toContain(".chatToolbar[data-dock-request='strip']")
    expect(chatCss).not.toMatch(/\.chatToolbar\[data-dock-request='strip'\][^{]*display:\s*contents/)

    // Floating dock collapses only when empty/unoccupied
    expect(chatCss).toMatch(/\.chatToolbar\[data-dock-request='floating'\]:not\(:has\(> button:not\(\[hidden\]\), > \.nativeDockActions > button:not\(\[hidden\]\), > \[data-component='QuickToolbar'\]\)\):not\(\[data-spindle-occupied\]\)/)
  })
})
