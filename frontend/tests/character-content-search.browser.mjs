import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), appType: 'custom', logLevel: 'warn',
  resolve: config.resolve, optimizeDeps: { entries: ['tests/character-content-search.fixture.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/tests/character-content-search.fixture.tsx"></script>'))
})
await server.listen()
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [360, 1280]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 800 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
        const scope = page.getByRole('combobox', { name: 'Search in' })
        await scope.waitFor()
        assert.equal(await scope.inputValue(), 'metadata')
        await scope.selectOption('all')
        const search = page.getByPlaceholder('Search all character fields...')
        await search.fill('a friend')
        assert.match(await page.getByRole('status').innerText(), /at least 3 characters/)
        await search.fill('magic school')
        assert.match(await page.getByRole('status').innerText(), /Includes greetings/)
        assert(await scope.evaluate(node => !!document.getElementById(node.getAttribute('aria-describedby'))))
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'search controls fit the viewport')
        if (name === 'chromium') await page.screenshot({ path: `/tmp/character-content-search-${width}.png` })
        await page.getByRole('button', { name: 'Group Chats', exact: true }).click()
        assert.equal(await scope.count(), 0, 'group search retains its own semantics')
        await page.getByRole('button', { name: 'Characters', exact: true }).click()
        assert.equal(await scope.inputValue(), 'all')
        await scope.selectOption('metadata')
        assert.equal(await page.getByRole('status').count(), 0)
        assert.equal(await search.count(), 0)
        assert.deepEqual(errors, [])
        console.log(`${name} ${width}px: scope, hints, group tab and overflow passed`)
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
