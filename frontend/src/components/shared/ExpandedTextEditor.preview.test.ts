import { describe, expect, test } from 'bun:test'

const componentSource = await Bun.file(new URL('./ExpandedTextEditor.tsx', import.meta.url)).text()
const cssSource = await Bun.file(new URL('./ExpandedTextEditor.module.css', import.meta.url)).text()
const viewportSource = await Bun.file(new URL('../../main.tsx', import.meta.url)).text()

describe('ExpandedTextEditor Markdown preview', () => {
  test('toggles between the editor and the chat Markdown renderer', () => {
    expect(componentSource).toContain("import MessageContent from '@/components/chat/MessageContent'")
    expect(componentSource).toContain("const [showMarkdownPreview, setShowMarkdownPreview] = useState(false)")
    expect(componentSource).toContain('aria-pressed={showMarkdownPreview}')
    expect(componentSource).toContain('<MessageContent')
    expect(componentSource).toContain('disableInterceptors')
  })

  test('keeps the rendered preview scrollable inside the modal body', () => {
    const previewBlock = cssSource.match(/\.markdownPreview\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(previewBlock).toMatch(/overflow:\s*auto/)
    expect(previewBlock).toMatch(/min-height:\s*0/)
  })
})

describe('ExpandedTextEditor mobile editing stability', () => {
  test('aligns the overlay with the visible viewport while the page is zoomed', () => {
    expect(viewportSource).toContain("root.style.setProperty('--app-visual-viewport-offset-top'")
    expect(viewportSource).toContain("root.style.setProperty('--app-visual-viewport-offset-left'")
    expect(viewportSource).toContain("root.style.setProperty('--app-visual-viewport-width'")
    expect(viewportSource).toContain("root.style.setProperty('--app-visual-viewport-height'")

    const viewportBlock = cssSource.match(/\.viewport\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(viewportBlock).toContain('top: calc(var(--app-visual-viewport-offset-top)')
    expect(viewportBlock).toContain('left: calc(var(--app-visual-viewport-offset-left)')
    expect(viewportBlock).toContain('height: calc(var(--app-visual-viewport-height)')
    expect(viewportBlock).toContain('width: calc(var(--app-visual-viewport-width)')
  })

  test('focuses programmatically without allowing keyboard presentation to scroll the page', () => {
    expect(componentSource).toContain('textarea.focus({ preventScroll: true })')
    // reset.css already clips the document. Do not turn it back into a
    // programmatically scrollable overflow:hidden element while editing.
    expect(componentSource).not.toContain('document.documentElement.style.overflow =')
  })

  test('keeps syntax highlighting enabled on touch-only devices', () => {
    const touchBlock = cssSource.match(/@media \(any-hover: none\)\s*\{([\s\S]*)\n\}/)?.[1] ?? ''
    expect(touchBlock).not.toMatch(/\.highlightPre\s*\{[\s\S]*?display:\s*none/)
    expect(touchBlock).not.toMatch(/\.textareaHighlighted\s*\{[\s\S]*?-webkit-text-fill-color:\s*var\(--lumiverse-text\)/)

    const highlightedTextareaBlock = cssSource.match(/\.textareaHighlighted\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(highlightedTextareaBlock).toMatch(/-webkit-text-fill-color:\s*transparent/)
  })

  test('bounds the shared grid while the textarea owns scrolling', () => {
    const innerBlock = cssSource.match(/\.highlightInner\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(innerBlock).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/)
    const textareaBlock = cssSource.match(/\n\.textareaHighlighted\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(textareaBlock).toMatch(/overflow-y:\s*auto/)
    expect(cssSource).toContain('scrollbar-gutter: stable')
  })

  test('auto-focuses desktop editors but waits for an explicit tap on touch-only devices', () => {
    expect(componentSource).toContain("window.matchMedia?.('(any-hover: none)').matches")
    expect(componentSource).toContain('if (autoFocus) pendingSelectionRef.current =')
  })

  test('does not use tap-coordinate recovery, viewport timers, or ancestor scrollIntoView', () => {
    expect(componentSource).not.toContain('mobileTapRef')
    expect(componentSource).not.toContain('recoverTappedCaret')
    expect(componentSource).not.toContain('setTimeout')
    expect(componentSource).not.toContain('scrollIntoView')
  })

  test('masks only the source textarea while preserving the contextual backdrop', () => {
    expect(componentSource).toContain("source.style.visibility = 'hidden'")
    expect(componentSource).toContain('source.style.visibility = visibility')
    expect(componentSource).toContain('sourceRef={textareaRef}')

    const glassOverlayBlock = cssSource.match(/:global\(\[data-glass\]\) \.overlay\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(glassOverlayBlock).toMatch(/background:\s*var\(--lumiverse-modal-backdrop/)
    expect(glassOverlayBlock).toMatch(/backdrop-filter:/)
  })
})
