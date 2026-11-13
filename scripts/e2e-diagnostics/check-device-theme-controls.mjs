// No backend or personal data: node scripts/e2e-diagnostics/check-device-theme-controls.mjs [chromium webkit]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'
import { launchTestBrowser } from './browser-runtime.mjs'

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
  entryPoints: ['frontend/tests/device-theme-controls.fixture.tsx'],
  outfile: 'device-theme-controls.js', bundle: true, write: false, format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'controlled-theme-host', setup(builder) {
    builder.onResolve({ filter: /^@\/store$/ }, () => ({ path: fileURLToPath(new URL('../../frontend/tests/device-theme-controls.store.ts', import.meta.url)) }))
    builder.onResolve({ filter: /^\.\/theme-panel\/(SavedThemes|ExtensionThemes)$/ }, () => ({ path: 'empty', namespace: 'fixture' }))
    builder.onResolve({ filter: /^@\/hooks\/useThemePackActions$/ }, () => ({ path: 'pack-actions', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'empty'
      ? 'export default function Empty() { return null }'
      : 'export function useThemePackActions() { return { handleExportPack() {}, handleImportPack() {} } }' }))
  } }],
})
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).text
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/fixture.js' ? js : `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const scale = page => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale')))
const openDevice = async page => {
  const summary = page.locator('summary').filter({ hasText: 'Device-specific controls' })
  await summary.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('checkbox', { name: 'Use device-specific controls' }).waitFor({ state: 'visible' })
}

try {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
    const launched = await launchTestBrowser(name)
    const { browser } = launched
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext(mobile
          ? { ...playwright.devices['iPhone 13'], reducedMotion: 'reduce' }
          : { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(url)
        await page.getByRole('button', { name: 'Save to My Themes' }).waitFor()
        assert.equal(await scale(page), 1.1)
        assert.equal(await page.locator('details').getAttribute('open'), null)
        await openDevice(page)
        await page.getByRole('checkbox', { name: 'Use device-specific controls' }).check()
        if (mobile) await page.getByRole('button', { name: 'Unlock controls', exact: true }).last().click()
        const slider = page.getByRole('slider', { name: 'UI Scale' })
        await slider.focus()
        for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowLeft')
        await settle(page)
        assert.equal(await scale(page), 0.75)
        if (!mobile) {
          // Real pointer interaction must commit on release, alongside the keyboard path.
          const bounds = await slider.boundingBox()
          await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
          await settle(page)
          assert.equal(await scale(page), 1)
          assert.equal(Number(await slider.inputValue()), 1, 'released slider value matches the committed scale')
          await slider.focus()
          for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
          await settle(page)
          assert.equal(await scale(page), 0.75)
        }
        assert.equal(await page.evaluate(() => window.deviceFixture.store.getState().writes), 0)
        const font = page.getByRole('slider', { name: 'Font Scale' })
        await font.focus()
        await page.keyboard.press('ArrowRight')
        await page.getByRole('checkbox', { name: 'Glass effects', exact: true }).uncheck()
        assert.equal(await page.locator('html').getAttribute('data-glass'), null)
        await page.getByRole('button', { name: 'Save to My Themes' }).click()
        assert.equal(await page.evaluate(() => window.deviceFixture.store.getState().saved.uiScale), 1.1)
        // A synced theme update changes colors and authored controls without changing this device's scale.
        await page.evaluate(() => {
          const { store } = window.deviceFixture
          store.getState().setTheme({ ...store.getState().theme, uiScale: 1.4, fontScale: 1.5 })
        })
        await settle(page)
        assert.equal(await scale(page), 0.75)
        await page.getByRole('button', { name: 'Copy device controls into theme' }).click()
        await page.getByRole('button', { name: 'Save to My Themes' }).click()
        assert.equal(await page.evaluate(() => window.deviceFixture.store.getState().saved.uiScale), 0.75)
        await page.getByRole('button', { name: 'Close theme panel' }).click()
        await page.getByRole('button', { name: 'Open theme panel' }).click()
        assert.equal(await page.getByRole('slider', { name: 'UI Scale' }).inputValue(), '0.75')
        await page.reload()
        await page.getByRole('button', { name: 'Save to My Themes' }).waitFor()
        assert.equal(await scale(page), 0.75)
        await openDevice(page)
        await page.getByRole('button', { name: 'Reset device controls from theme' }).click()
        await settle(page)
        assert.equal(await scale(page), 1.1)
        await page.getByRole('checkbox', { name: 'Use device-specific controls' }).uncheck()
        assert.equal(await page.getByRole('button', { name: 'Copy device controls into theme' }).isDisabled(), true)
        // Storage changes are picked up in another same-origin window.
        const second = await context.newPage()
        await second.goto(url)
        await second.getByRole('button', { name: 'Save to My Themes' }).waitFor()
        await page.getByRole('checkbox', { name: 'Use device-specific controls' }).check()
        await settle(second)
        assert.equal(await second.evaluate(() => window.deviceFixture.device.getState().enabled), true)
        // Account switching clears the local override and restores it on return.
        await page.evaluate(() => window.deviceFixture.scope('other-user'))
        await settle(page)
        assert.equal(await page.getByRole('checkbox', { name: 'Use device-specific controls' }).isChecked(), false)
        await page.evaluate(() => window.deviceFixture.scope('fixture-user'))
        await settle(page)
        assert.equal(await page.getByRole('checkbox', { name: 'Use device-specific controls' }).isChecked(), true)
        if (mobile) {
          // Simulate the shell's existing safe-top primitive; no component-specific notch offsets.
          await page.evaluate(() => document.documentElement.style.setProperty('--app-interactive-safe-top', '47px'))
          await page.locator('main').evaluate(el => el.scrollTo(0, 0))
          const top = await page.getByRole('button', { name: 'Close theme panel' }).evaluate(el => el.getBoundingClientRect().top)
          assert.ok(top >= 47, `mobile controls overlap safe top: ${top}`)
          const overflow = await page.locator('main').evaluate(main => ({
            width: main.clientWidth, scrollWidth: main.scrollWidth,
            children: Array.from(main.querySelectorAll('*')).filter(el => el.getBoundingClientRect().right > main.getBoundingClientRect().right + 1).map(el => ({ tag: el.tagName, cls: el.className, text: el.textContent.slice(0, 70), right: el.getBoundingClientRect().right })),
          }))
          if (process.env.DEVICE_THEME_SCREENSHOT_DIR) {
            await page.locator('summary').scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${process.env.DEVICE_THEME_SCREENSHOT_DIR}/${name}-device-controls.png` })
          }
          assert.ok(overflow.scrollWidth <= overflow.width + 1, `mobile horizontal overflow: ${JSON.stringify(overflow)}`)
        }
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`${name}/${mobile ? 'iPhone' : 'desktop'}: passed`)
      }
    } finally { await launched.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
