import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

// Use the real production entry point, import map, chunks, and Workbox worker.
// Two HTML revisions model a deployment without rebuilding all assets twice.
const args = process.argv.slice(2)
const distArgument = args.find(arg => arg.startsWith('--dist='))?.slice('--dist='.length)
const browserNames = args.filter(arg => !arg.startsWith('--dist='))
const dist = resolve(distArgument || process.env.PWA_DIST || fileURLToPath(new URL('../../frontend/dist', import.meta.url)))
const originalHtml = await readFile(resolve(dist, 'index.html'), 'utf8')
const originalWorker = await readFile(resolve(dist, 'sw.js'), 'utf8')
assert.match(originalHtml, /name="lumiverse-build-id" content="[^"]+"/)
assert.match(originalWorker, /"revision":"[a-f0-9]+","url":"index\.html"/)
let revision = 'old'
const html = () => originalHtml.replace(/(name="lumiverse-build-id" content=")[^"]+/, `$1upgrade-${revision}`)
const worker = () => originalWorker.replace(
  /"revision":"[a-f0-9]+","url":"index\.html"/,
  `"revision":"${createHash('md5').update(html()).digest('hex')}","url":"index.html"`,
)
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    res.setHeader('Cache-Control', 'no-cache')
    if (path === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.setHeader('Service-Worker-Allowed', '/')
      res.end(worker())
      return
    }
    if (path === '/' || path === '/index.html') {
      res.setHeader('Content-Type', 'text/html')
      res.end(html())
      return
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`)
    if (!file.startsWith(dist + sep) || !(await stat(file)).isFile()) throw new Error('missing')
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"Not found"}')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
try {
  for (const name of browserNames.length ? browserNames : ['chromium', 'firefox', 'webkit']) {
    revision = 'old'
    const runtime = await launchTestBrowser(name)
    try {
      const context = await runtime.browser.newContext()
      const first = await context.newPage()
      await first.goto(url)
      await first.waitForFunction(() => !!navigator.serviceWorker.controller)
      assert.equal(await first.locator('meta[name="lumiverse-build-id"]').getAttribute('content'), 'upgrade-old')
      await first.evaluate(() => localStorage.setItem('upgrade-survives', 'yes'))
      const second = await context.newPage()
      await second.goto(url)
      await second.waitForFunction(() => !!navigator.serviceWorker.controller)
      // Only one tab checks; both must reload from the new worker's precache.
      revision = 'new'
      await first.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update() }).catch(error => {
        // Firefox can replace this realm before update() resolves.
        if (!error.message.includes('Execution context was destroyed')) throw error
      })
      for (const page of [first, second]) {
        await page.waitForFunction(() => document.querySelector('meta[name="lumiverse-build-id"]')?.content === 'upgrade-new')
        assert.equal(await page.evaluate(() => localStorage.getItem('upgrade-survives')), 'yes')
        assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true)
      }
      // Reloading offline must still use the matching HTML and import-map assets.
      await context.setOffline(true)
      await second.reload()
      assert.equal(await second.locator('meta[name="lumiverse-build-id"]').getAttribute('content'), 'upgrade-new')
      console.log(`${name}: production worker upgrade, both tabs, preserved storage, and offline reload pass`)
    } finally { await runtime.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
