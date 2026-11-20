// Run from any directory: node scripts/e2e-diagnostics/check-ui-scale.mjs
// Optional: UI_SCALE_BROWSERS=chromium (default: chromium,firefox,webkit).
// Uses the actual CSS modules and React 19 components; no backend is needed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['frontend/tests/ui-scale.fixture.tsx'],
  outfile: 'ui-scale-fixture.js',
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: expected ${expected}, got ${actual}`)
const rect = (page, selector) => page.locator(selector).evaluate(el => el.getBoundingClientRect().toJSON())
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const change = async (page, method, value) => {
  await page.evaluate(([method, value]) => window.uiScaleFixture[method](value), [method, value])
  await settle(page)
}

let cases = 0
for (const name of (process.env.UI_SCALE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true })
  const previousCases = cases
  try {
    for (const mode of ['web', 'desktop', 'linux', 'pwa', 'ios-pwa', 'android']) {
      for (const width of [1200, 390, 320]) {
        if (process.env.UI_SCALE_FILTER && !`${name}/${mode}/${width}`.includes(process.env.UI_SCALE_FILTER)) continue
        const height = 800
        const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', ...(mode === 'android' ? { isMobile: true, hasTouch: true } : {}) })
        page.setDefaultTimeout(10_000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        // Exercise the installed-PWA rules without installing a PWA. Browser
        // automation has no cross-engine display-mode emulation API.
        const modeCss = mode.includes('pwa') ? css.replace(/@media\s*\(display-mode: standalone\),\s*\(display-mode: window-controls-overlay\)/g, '@media all') : css
        const attributes = mode === 'linux' ? 'data-tauri-desktop data-platform="linux"'
          : mode === 'desktop' ? 'data-tauri-desktop'
          : mode === 'ios-pwa' ? 'data-pwa data-ios-pwa'
          : mode === 'pwa' ? 'data-pwa'
          : mode === 'android' ? 'data-tauri-mobile="android" data-platform="android"' : ''
        await page.setContent(`<html ${attributes}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${modeCss}</style></head><body><div id="root"></div></body></html>`)
        await page.addScriptTag({ content: js })
        await page.waitForFunction(() => !!window.uiScaleFixture)

        // Return to 100% at the end to catch stale sizing after live changes.
        for (const scale of [0.5, 0.8, 1, 1.25, 1.5, 1]) {
          const label = `${name}/${mode}/${width}/${scale}`
          await change(page, 'setScale', scale)
          for (const shell of [true, false]) {
            await change(page, 'setShell', shell)
            for (const selector of ['body', '#root', '#surface', '#full-portal']) {
              const box = await rect(page, selector)
              near(box.left, 0, `${label} ${selector} left`)
              near(box.top, 0, `${label} ${selector} top`)
              near(box.width, width, `${label} ${selector} width`)
              near(box.height, height, `${label} ${selector} height`)
            }
          }
          await change(page, 'setShell', true)
          for (const selector of ['#fixed-control', '#direct-portal', '#nested-portal']) {
            const box = await rect(page, selector)
            near(box.right, width - 16 * scale, `${label} ${selector} right`)
            near(box.bottom, height - 16 * scale, `${label} ${selector} bottom`)
            near(box.width, 100 * scale, `${label} ${selector} width`)
          }
          const center = await rect(page, '#center-portal')
          near(center.left + center.width / 2, width / 2, `${label} center x`)
          near(center.top + center.height / 2, height / 2, `${label} center y`)

          // A real body-portal dropdown must remain attached to its trigger.
          const select = page.getByRole('button', { name: 'Scale test select' })
          await select.click()
          const trigger = await select.boundingBox()
          const option = page.getByRole('option', { name: /Second option$/ })
          await option.waitFor()
          const popover = await option.evaluate(el => el.parentElement.parentElement.getBoundingClientRect().toJSON())
          near(popover.top, trigger.y + trigger.height + 4, `${label} dropdown top`)
          assert.ok(popover.left >= 0 && popover.right <= width, `${label} dropdown fits`)
          await option.click()

          await change(page, 'setModal', true)
          await page.waitForTimeout(250) // ModalShell's entrance transform must finish.
          const backdrop = await page.locator('#modal-content').evaluate(el => el.parentElement.parentElement.getBoundingClientRect().toJSON())
          near(backdrop.width, width, `${label} backdrop width`)
          near(backdrop.height, height, `${label} backdrop height`)
          const modal = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
          assert.ok(modal.left >= 0 && modal.right <= width && modal.top >= 0 && modal.bottom <= height, `${label} tall modal fits`)
          if (width <= 600 || mode === 'android') {
            near(modal.width, Math.min(560, width - 24), `${label} mobile dialog respects its width and gutter`)
            assert.ok(modal.height <= height * 0.9 + 1, `${label} mobile dialog keeps its viewport height cap`)
            assert.ok(modal.left >= 11 && modal.right <= width - 11 && modal.top >= 11 && modal.bottom <= height - 11, `${label} modal leaves visible margins`)
          }
          await page.keyboard.press('Escape')
          await page.locator('#modal-content').waitFor({ state: 'detached' })

          if (width <= 600 || mode === 'android') {
            await change(page, 'setCompact', true)
            await change(page, 'setModal', true)
            await page.waitForTimeout(250)
            const compact = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
            near(compact.width, Math.min(420, width - 24), `${label} compact dialog keeps requested width`)
            assert.ok(compact.height < height / 2, `${label} short prompt keeps natural height`)
            await change(page, 'setModal', false)
            await page.locator('#modal-content').waitFor({ state: 'detached' })
            await change(page, 'setCompact', false)
            await change(page, 'setSettings', true)
            const settings = await rect(page, '#settings-fixture')
            near(settings.width, Math.min(1200, width - 24), `${label} mobile settings width`)
            near(settings.height, (height - 24) * 0.88, `${label} mobile settings height`)
            assert.ok(settings.left >= 11 && settings.right <= width - 11 && settings.top >= 11 && settings.bottom <= height - 11, `${label} settings leaves visible margins`)
            await change(page, 'setSettings', false)

            // Fullscreen is reserved for callers that explicitly request it.
            await change(page, 'setFullscreen', true)
            await change(page, 'setModal', true)
            await page.waitForTimeout(250)
            const fullscreen = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
            near(fullscreen.width, width, `${label} explicit fullscreen width`)
            near(fullscreen.height, height, `${label} explicit fullscreen height`)
            await change(page, 'setModal', false)
            await page.locator('#modal-content').waitFor({ state: 'detached' })
            await change(page, 'setFullscreen', false)
          }

          await change(page, 'setMenu', { x: width - 4, y: height - 4 })
          await page.waitForTimeout(180) // ContextMenu's scale entrance animation.
          const menu = await page.getByText('Menu item', { exact: true }).evaluate(el => el.closest('button').parentElement.getBoundingClientRect().toJSON())
          assert.ok(menu.right <= width && menu.bottom <= height && menu.left >= 0 && menu.top >= 0, `${label} context menu fits`)
          await page.keyboard.press('Escape')
          await page.getByText('Menu item', { exact: true }).waitFor({ state: 'detached' })

          // Pointer deltas are rendered pixels; scrolling is in layout pixels.
          await page.locator('#drag-scroll').evaluate(el => { el.scrollTop = 0 })
          const row = await rect(page, '#row-1')
          const x = row.left + 20, y = row.top + row.height / 2
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x + 30, y + 20, { steps: 5 })
          await settle(page)
          const dragged = await rect(page, '#row-1')
          near(dragged.left - row.left, 30, `${label} drag x`)
          near(dragged.top - row.top, 20, `${label} drag y`)
          await page.locator('#drag-scroll').evaluate(el => { el.scrollTop = 40 })
          await page.mouse.move(x + 35, y + 25, { steps: 3 })
          await settle(page)
          const scrolled = await rect(page, '#row-1')
          near(scrolled.top - row.top, 25, `${label} drag after scroll`)
          await page.mouse.up()
          assert.equal(await page.locator('#surface').evaluate(el => el.scrollLeft), 0, `${label} shell must not pan on focus`)

          assert.deepEqual(errors, [], `${label} browser errors`)
          cases++
        }

        if (width <= 600 || mode === 'android') {
          // Callers use both raw CSS caps and limits already converted to the
          // body's layout space. Neither should shrink twice at small scales.
          await change(page, 'setMaxWidth', 'clamp(320px, 90vw, 520px)')
          await change(page, 'setMaxHeight', 'calc(80dvh / var(--lumiverse-ui-scale, 1))')
          for (const scale of [0.5, 1.5]) {
            await change(page, 'setScale', scale)
            await change(page, 'setModal', true)
            await page.waitForTimeout(250)
            const capped = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
            near(capped.width, Math.min(Math.max(320, Math.min(width * 0.9, 520)), width - 24), `${name}/${mode}/${width}/${scale} CSS width cap`)
            assert.ok(capped.height <= height * 0.8 + 1, `${name}/${mode}/${width}/${scale} compensated height cap`)
            await page.evaluate(() => document.documentElement.style.setProperty('--fixture-modal-height', 'calc(80dvh / var(--lumiverse-ui-scale, 1))'))
            await change(page, 'setMaxHeight', 'var(--fixture-modal-height)')
            const variableCap = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
            near(variableCap.height, capped.height, `${name}/${mode}/${width}/${scale} caller-resolved height cap`)
            await change(page, 'setMaxHeight', 'calc(80dvh / var(--lumiverse-ui-scale, 1))')
            await change(page, 'setModal', false)
            await page.locator('#modal-content').waitFor({ state: 'detached' })
          }
          await change(page, 'setMaxWidth', 560)
          await change(page, 'setMaxHeight', '90vh')
          await page.evaluate(() => document.documentElement.style.removeProperty('--fixture-modal-height'))
        }

        // A shrinking visual viewport must constrain overlays without also
        // shrinking the stable shell and double-counting keyboard clearance.
        await change(page, 'setScale', 1.5)
        const mobile = width <= 600 || mode === 'android'
        await page.evaluate(mobile => {
          document.documentElement.style.setProperty('--app-viewport-height', '480px')
          if (mobile) document.documentElement.style.setProperty('--app-interactive-safe-top', '32px')
        }, mobile)
        near((await rect(page, 'body')).height, height, `${name}/${mode} keyboard body`)
        near((await rect(page, '#surface')).height, height, `${name}/${mode} keyboard shell`)
        await change(page, 'setModal', true)
        await page.waitForTimeout(250)
        const keyboardModal = await page.locator('#modal-content').evaluate(el => el.parentElement.getBoundingClientRect().toJSON())
        assert.ok(keyboardModal.top >= 0 && keyboardModal.bottom <= 480, `${name}/${mode} keyboard modal fits`)
        const gutter = mobile ? 12 : 20
        assert.ok(keyboardModal.top >= gutter + (mobile ? 32 : 0) - 1 && keyboardModal.bottom <= 480 - gutter + 1, `${name}/${mode} keyboard modal keeps its gutter and safe area`)
        await change(page, 'setModal', false)
        await page.evaluate(() => {
          document.documentElement.style.removeProperty('--app-viewport-height')
          document.documentElement.style.removeProperty('--app-interactive-safe-top')
        })

        await page.setViewportSize({ width: width + 100, height: 600 })
        await settle(page)
        near((await rect(page, '#root')).width, width + 100, `${name}/${mode} resized root width`)
        near((await rect(page, '#root')).height, 600, `${name}/${mode} resized root height`)
        await page.close()
        console.log(`${name}/${mode}/${width}: passed`)
      }
    }
    if (cases > previousCases) console.log(`${name}: ${cases - previousCases} scale cases passed`)
  } finally {
    await browser.close()
  }
}
console.log(`${cases} UI scale browser cases passed`)
