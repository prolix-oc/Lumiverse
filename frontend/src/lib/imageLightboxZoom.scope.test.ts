import { describe, expect, test } from 'bun:test'

const indexHtml = await Bun.file(new URL('../../index.html', import.meta.url)).text()
const widgetHtml = await Bun.file(new URL('../../widget.html', import.meta.url)).text()
const mainSource = await Bun.file(new URL('../main.tsx', import.meta.url)).text()
const globalCss = await Bun.file(new URL('../theme/global.css', import.meta.url)).text()
const resetCss = await Bun.file(new URL('../theme/reset.css', import.meta.url)).text()
const lightboxCss = await Bun.file(new URL('../components/shared/ImageLightbox.module.css', import.meta.url)).text()

describe('image-only pinch zoom', () => {
  test('prevents native page zoom without disabling image gestures', () => {
    expect(indexHtml).toContain('maximum-scale=1.0, user-scalable=no')
    expect(widgetHtml).toContain('maximum-scale=1.0, user-scalable=no')
    expect(resetCss).toContain('touch-action: pan-x pan-y')
    expect(globalCss).toContain('touch-action: pan-x pan-y')
    expect(mainSource).toContain("document.addEventListener('gesturestart', (event) => event.preventDefault()")
    expect(mainSource).toContain("document.addEventListener('gesturechange', (event) => event.preventDefault()")
    expect(mainSource).toContain("import { installIOSTouchScrollGuard, preventPageTouchZoom } from './lib/iosTouchScroll'")
    expect(mainSource).toContain("document.addEventListener('touchmove', preventPageTouchZoom, { passive: false })")
    expect(lightboxCss.match(/\.backdrop\s*\{([\s\S]*?)\n\}/)?.[1]).toContain('touch-action: none')
    expect(lightboxCss.match(/\.image\s*\{([\s\S]*?)\n\}/)?.[1]).toContain('touch-action: none')
  })
})
