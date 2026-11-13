import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', plugins: [react()], logLevel: 'warn',
  optimizeDeps: { entries: ['tests/connection-manager-layout.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}/src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__connection-manager-scroll', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__connection-manager-scroll', '<html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/connection-manager-layout.fixture.tsx"></script></body></html>'))
})
await server.listen()
const name = process.env.CONNECTION_BROWSER || 'chromium'
const runtime = await launchTestBrowser(name)
const { browser } = runtime
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
page.setDefaultTimeout(10000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const panel = page.locator('main')
const url = `http://127.0.0.1:${server.httpServer.address().port}/__connection-manager-scroll`
const scrollTop = () => panel.evaluate(node => node.scrollTop)
const inViewport = locator => locator.evaluate(node => {
  const rect = node.getBoundingClientRect()
  return rect.top >= 0 && rect.bottom <= innerHeight
})
async function wheelToBottom() {
  // Stop touch momentum before changing input methods.
  await panel.evaluate(node => { node.scrollTop = node.scrollTop })
  await page.mouse.move(195, 600)
  // Firefox caps individual wheel deltas; keep sending real wheel input until
  // the bottom is reached instead of assuming one large delta is enough.
  for (let step = 0; step < 20; step++) {
    await page.mouse.wheel(0, 10000)
    await page.waitForTimeout(100)
    if (await panel.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2)) break
  }
  await page.waitForFunction(() => {
    const node = document.querySelector('main')
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 2
  })
}
async function swipeHeader() {
  const cdp = await page.context().newCDPSession(page)
  const header = page.locator('[data-sortable-folder="folder-0"] button[aria-expanded]')
  await header.scrollIntoViewIfNeeded()
  const box = await header.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  const before = await scrollTop()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  // Move immediately: the 200ms long-press sensor must yield to native panning.
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20, id: 1 }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await page.waitForTimeout(350)
  assert(await scrollTop() > before + 40, 'swiping a folder header must scroll the panel')
  assert.equal(await header.getAttribute('aria-expanded'), 'false', 'a swipe must not toggle the folder')
}
try {
  for (const kind of ['llm', 'imageGen', 'stt', 'tts', 'decision', 'embedding']) {
    console.log(`Checking ${name}: ${kind}`)
    await page.goto(`${url}?stress=1&kind=${kind}`)
    const first = page.locator('[data-sortable-folder="folder-0"] button[aria-expanded]')
    await first.waitFor({ timeout: 60000 })
    assert.equal(await page.locator('[data-sortable-folder]').count(), 31)
    assert.equal(await first.getAttribute('aria-expanded'), 'false')
    assert(await panel.evaluate(node => node.scrollHeight > node.clientHeight), 'folders must overflow the viewport')
    if (name === 'chromium') await swipeHeader()
    // WebKit and Firefox also need a header that permits native vertical panning.
    assert(['auto', 'pan-y', 'manipulation'].includes(await first.evaluate(node => getComputedStyle(node).touchAction)),
      'folder headers must allow native touch scrolling')
    await wheelToBottom()
    assert(await inViewport(page.locator('[data-sortable-folder=""] button[aria-expanded]')), 'the last folder must be reachable')
    await first.click()
    assert.equal(await first.getAttribute('aria-expanded'), 'true')
    await wheelToBottom()
    assert(await page.locator('[id$="-connection-59"]').isVisible(), 'all 60 connections stay mounted in the expanded folder')
    await page.locator('[id$="-connection-59"]').scrollIntoViewIfNeeded()
    assert(await inViewport(page.locator('[id$="-connection-59"]')), 'the last connection in a large folder must be reachable')
    assert.equal(await page.locator('[data-connection-drag]').count(), 0)
  }
  assert.deepEqual(errors, [])
  console.log(`PASS (${name}): six managers, 90 connections, 30 folders, scrollable headers, wheel scrolling and last-row access${name === 'chromium' ? ', native touch swipes' : ''}`)
} catch (error) {
  console.error(await panel.evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight,
    hit: document.elementFromPoint(195, 600)?.outerHTML, body: document.body.style.cssText })))
  throw error
} finally {
  await runtime.close()
  await server.close()
}
