// Real core modal/list/editor with controlled API/store boundaries; no login or user data.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('../../frontend/tests/world-book-workspace.fixture.tsx', import.meta.url))
const browsers = (process.env.QUICK_CONTROLS_BROWSERS ?? 'chromium,firefox,webkit').split(',')
const mocked = new Set(['@/store', '@/api/world-books', '@/ws/client', '@/hooks/useWorldBookListLiveSync', '@/hooks/useFolders', '@/hooks/useTokenCounts', 'react-i18next', '@/api/macros', '@/lib/loom/service', '@/components/chat/MessageContent', '@/components/shared/ConfirmationModal', '@/components/shared/PostImportWorldBookModal', '@/components/panels/world-book/WorldBookDiagnosticsModal', '@/components/panels/world-book/WorldBookTokenReportModal'])
const bundle = await build({ absWorkingDir: root, entryPoints: [fixture], outfile: 'workspace.js', bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, plugins: [{ name: 'controlled-workspace', setup(build) { build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture-i18n' })); build.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: 'export default { t: key => key }', loader: 'js' })); build.onResolve({ filter: /.*/ }, args => { if (mocked.has(args.path) || args.path.endsWith('/ImportWorldBookModal')) return { path: fixture } }) } }] })
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const playwright = process.env.PLAYWRIGHT_MODULE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) : await import('playwright')
const theme = `*{box-sizing:border-box;margin:0}html{--app-interactive-safe-top:32px;--lumiverse-bg:#211e2b;--lumiverse-bg-deep:#17151e;--lumiverse-text:#eee;--lumiverse-text-muted:#aaa;--lumiverse-text-dim:#999;--lumiverse-border:#484451;--lumiverse-fill-subtle:#2a2735;--lumiverse-fill-hover:#343040;--lumiverse-primary:#a999db;--lumiverse-font-scale:1;--lumiverse-radius-xl:14px}body{zoom:var(--lumiverse-ui-scale);font:14px Arial;height:calc(100dvh / var(--lumiverse-ui-scale));width:calc(100vw / var(--lumiverse-ui-scale))}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}input,select,textarea{background:var(--lumiverse-bg)}`
// Collapsed quick edits through the real core modal/sidebar and controlled API.
for (const name of browsers) {
 const browser = await playwright[name].launch({ headless: true, timeout: 15000 })
 try { for (const surface of ['workspace', 'sidebar']) for (const width of [1200, 390]) for (const scale of [1, 1.25]) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1,viewport-fit=cover"><style>' + theme + css + '</style></head><body><div id="root"></div><script>' + js + '</script></body></html>' }))
  try {
   console.log(name + '/' + surface + '/' + width + '/' + scale)
   await page.goto('http://fixture.local/?reorderFixture&quickControlsFixture&flatBook&surface=' + surface + '&scale=' + scale)
   const row = page.locator('[data-world-book-entry-row="b5-e0"]')
   const order = row.getByRole('spinbutton', { name: 'order: Fixture entry 0', exact: true })
   await order.waitFor()
   await order.fill('123')
   await order.press('Enter')
   await page.waitForFunction(() => document.querySelector('[data-world-book-entry-row="b5-e0"]')?.dataset.worldBookEntryRevision === '2')
   assert.equal(await order.inputValue(), '123')
   await order.fill('999'); await order.press('Escape')
   assert.equal(await order.inputValue(), '123')
   await order.fill(''); await order.press('Tab')
   assert.equal(await order.inputValue(), '123')
   const type = row.getByRole('button', { name: 'changeEntryTypeFrom: Fixture entry 0', exact: true })
   await type.focus()
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
   await type.press('Enter')
   await page.waitForFunction(() => document.querySelector('[data-world-book-entry-row="b5-e0"] button[aria-label^="changeEntryTypeFrom:"]')?.getAttribute('aria-expanded') === 'true')
   const constant = page.getByRole('button', { name: 'entryType.constant', exact: true })
   await constant.focus(); await constant.press('Enter')
   await page.waitForFunction(() => document.querySelector('[data-world-book-entry-row="b5-e0"]')?.dataset.worldBookEntryRevision === '3')
   assert.ok((await type.textContent()).includes('entryType.constant'))
   assert.equal(await type.getAttribute('aria-expanded'), 'false')
   const position = row.getByRole('button', { name: 'changeEntryPositionFrom: Fixture entry 0', exact: true })
   await position.scrollIntoViewIfNeeded()
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
   await position.click()
   await page.getByRole('button', { name: 'entryPosition.afterMain', exact: true }).click()
   await page.waitForFunction(() => document.querySelector('[data-world-book-entry-row="b5-e0"]')?.dataset.worldBookEntryRevision === '4')
   assert.ok((await position.textContent()).includes('entryPosition.afterMain'))
   await position.focus(); await position.press('Enter'); await page.keyboard.press('Escape')
   assert.equal(await page.getByRole('button', { name: 'entryPosition.beforeMain', exact: true }).count(), 0)
   assert.equal(await page.locator('[data-world-book-entry-editor]').count(), 0, 'quick edits never open an editor')
   const box = await order.boundingBox()
   assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 32, 'controls fit viewport and canonical safe top')
   // Opening and closing the actual editor retains committed quick edits.
   await row.getByRole('button', { name: surface === 'workspace' ? 'Open entry editor' : 'expandEditor', exact: true }).click()
   await page.locator('[data-world-book-entry-editor]').first().waitFor()
   if (surface === 'sidebar') await row.getByRole('button', { name: 'collapseEditor', exact: true }).click()
   else {
    if (width === 390) await page.getByRole('button', { name: '1 open', exact: true }).click()
    await page.getByRole('button', { name: 'Close tab Fixture entry 0', exact: true }).click()
   }
   assert.equal(await order.inputValue(), '123')
   // A remote update must retain the draft and focus. Escape adopts the latest
   // server value without writing the abandoned draft back to the server.
   const liveOrder = page.locator('[data-world-book-entry-row="b5-e1"]').getByRole('spinbutton')
   await liveOrder.fill('42')
   await page.evaluate(() => window.updateExternalOrder('b5-e1', 2))
   await page.waitForFunction(() => document.querySelector('[data-world-book-entry-row="b5-e1"]')?.dataset.worldBookEntryRevision === '2')
   assert.equal(await liveOrder.inputValue(), '42')
   assert.ok(await liveOrder.evaluate(input => document.activeElement === input), 'live updates retain keyboard focus')
   await liveOrder.press('Escape')
   assert.equal(await liveOrder.inputValue(), '2')
   assert.equal(await page.locator('[data-world-book-entry-row="b5-e1"]').getAttribute('data-world-book-entry-revision'), '2')
   assert.deepEqual(errors, [])
  } finally { await page.close() }
 } } finally { await browser.close() }
}
console.log(`Collapsed quick controls: ${browsers.length * 8} desktop/mobile/browser/scale cases passed`)
