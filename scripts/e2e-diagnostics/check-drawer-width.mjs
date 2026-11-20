// Real width controls and settings layout with controlled persisted state; no server or user data.
// Optional PLAYWRIGHT_MODULE path and DRAWER_WIDTH_BROWSERS=chromium,firefox,webkit.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
const playwright = process.env.PLAYWRIGHT_MODULE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) : await import('playwright')
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root, outfile: 'drawer-width.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  stdin: { resolveDir: root + '/frontend', loader: 'tsx', contents: `
    import { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import i18n from 'i18next'
    import { initReactI18next } from 'react-i18next'
    import en from './src/i18n/locales/en/settings.json'
    import DrawerWidthSettings from './src/components/settings/DrawerWidthSettings'
    import styles from './src/components/modals/SettingsModal.module.css'
    i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { settings: en } }, initImmediate: false })
    function Fixture() {
      const [open, setOpen] = useState(true)
      const [settings, setSettings] = useState(() => JSON.parse(localStorage.getItem('drawer') || '{"side":"right","panelWidthMode":"default","customPanelWidth":35,"panelWidthPx":650,"showTabLabels":true}'))
      function update(patch) {
        setSettings(current => { const next = { ...current, ...patch }; localStorage.setItem('drawer', JSON.stringify(next)); return next })
      }
      window.fixtureSettings = settings
      window.fixtureResize = width => update({ panelWidthPx: width })
      return <>{open ? <div className={styles.overlay}><section className={styles.modal} aria-label="Settings">
        <header className={styles.header}><h2>Display</h2><button onClick={() => setOpen(false)}>Close settings</button></header>
        <div className={styles.body}><div className={styles.content}>
          <DrawerWidthSettings settings={settings} onChange={update} />
        </div></div></section></div> : <button onClick={() => setOpen(true)}>Reopen settings</button>}</>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  ` },
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
let cases = 0
for (const name of (process.env.DRAWER_WIDTH_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true })
  try {
    for (const width of [1200, 390]) for (const scale of [1, 1.25]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' })
      const errors = []; page.on('pageerror', error => errors.push(error.message))
      const safeTop = width === 390 ? 47 : 0
      await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}html{--lumiverse-ui-scale:${scale};--app-interactive-safe-top:${safeTop / scale}px}#root{zoom:${scale}}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>` }))
      await page.goto('http://fixture.local/')
      const group = page.getByRole('group', { name: 'PANEL WIDTH', exact: true })
      const custom = group.getByRole('button', { name: 'Custom', exact: true })
      const defaults = group.getByRole('button', { name: 'Default', exact: true })
      const slider = page.getByRole('slider', { name: 'CUSTOM WIDTH (vw)', exact: true })
      await custom.click()
      assert.equal(await custom.getAttribute('aria-pressed'), 'true')
      assert.equal(await page.evaluate(() => window.fixtureSettings.panelWidthPx), undefined, 'custom clears drag override')
      assert.equal(await slider.inputValue(), '35')
      await slider.focus(); await page.keyboard.press('ArrowRight')
      assert.equal(await slider.inputValue(), '36', 'keyboard changes width')
      // Simulate a subsequent edge resize, then exercise the actual range pointer interaction.
      await page.evaluate(() => window.fixtureResize(700))
      await page.waitForFunction(() => window.fixtureSettings.panelWidthPx === 700)
      const box = await slider.boundingBox()
      await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2)
      assert.equal(await page.evaluate(() => window.fixtureSettings.panelWidthPx), undefined, 'slider clears drag override')
      const chosen = await slider.inputValue()
      assert.ok(Number(chosen) > 36)
      await slider.press('Home'); assert.equal(await slider.inputValue(), '20')
      await slider.press('End'); assert.equal(await slider.inputValue(), '80')
      await page.getByRole('button', { name: 'Close settings', exact: true }).click()
      await page.getByRole('button', { name: 'Reopen settings', exact: true }).click()
      assert.equal(await slider.inputValue(), '80', 'close/reopen retains width')
      await defaults.focus(); await page.keyboard.press('Enter')
      assert.equal(await slider.count(), 0)
      assert.equal(await defaults.getAttribute('aria-pressed'), 'true')
      await custom.focus(); await page.keyboard.press('Space')
      assert.equal(await slider.inputValue(), '80', 'default preserves saved custom width')
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('drawer')).panelWidthPx), undefined, 'override removed from persisted settings')
      await page.reload()
      assert.equal(await slider.inputValue(), '80', 'persisted width survives reload')
      assert.equal(await page.evaluate(() => window.fixtureSettings.side), 'right', 'preserves unrelated settings')
      for (const control of [custom, defaults, slider, page.getByRole('button', { name: 'Close settings', exact: true })]) {
        const bounds = await control.boundingBox()
        assert.ok(bounds.y >= safeTop - 1 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'controls respect safe top and viewport')
      }
      assert.deepEqual(errors, [])
      cases++; await page.close()
    }
  } finally { await browser.close() }
  console.log(name + ': drawer width pointer, keyboard, persistence and mobile layout passed')
}
console.log(cases + ' viewport/scale cases passed')
