// Real connection form and metadata round trips; no external provider calls.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const { default: react } = await import(require.resolve('@vitejs/plugin-react'))
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', plugins: [react()], logLevel: 'warn',
  optimizeDeps: { entries: ['tests/nanogpt-caching.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__nanogpt-caching', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__nanogpt-caching', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/nanogpt-caching.fixture.tsx"></script></body></html>'))
})
await server.listen()
try {
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const width of [1280, 390]) {
        for (const advanced of [{}, { autoCut: false, tailReserveMessages: 12 }, { auto_cut: false, tail_reserve_messages: 0 }]) {
          const page = await runtime.browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
          const errors = []
          page.on('pageerror', error => errors.push(error.message))
          page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
          await page.route('**/api/v1/**', route => route.fulfill({ json: { models: ['anthropic/claude-sonnet-4-5'], model_labels: {}, providers: [] } }))
          await page.addInitScript(advanced => {
            if (!localStorage.getItem('nanogpt-review-metadata')) localStorage.setItem('nanogpt-review-metadata', JSON.stringify({
              nanogpt_caching: { enabled: true, ttl: '1h', stickyProvider: true, ...advanced },
            }))
          }, advanced)
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__nanogpt-caching`)
          const cutoff = page.getByPlaceholder('e.g. 4', { exact: true })
          await cutoff.waitFor()
          assert.equal(await cutoff.inputValue(), '')
          await page.getByText(/Leave blank to derive a cutoff/).waitFor()
          await cutoff.fill('12')
          const save = async () => {
            await page.getByRole('button', { name: /^Save/ }).last().click()
            await page.waitForFunction(() => document.querySelector('output')?.textContent !== 'null')
            return JSON.parse(await page.getByLabel('Saved connection').textContent()).metadata.nanogpt_caching
          }
          const pinned = await save()
          assert.equal(pinned.cutAfterMessageIndex, 12)
          assert.equal(pinned.ttl, '1h')
          if ('autoCut' in advanced || 'auto_cut' in advanced) {
            assert.equal(pinned.autoCut, false)
            assert.equal(pinned.tailReserveMessages, advanced.tailReserveMessages ?? advanced.tail_reserve_messages)
          }
          await page.reload()
          await cutoff.waitFor()
          assert.equal(await cutoff.inputValue(), '12')
          await cutoff.fill('')
          const unpinned = await save()
          assert.equal(unpinned.cutAfterMessageIndex, undefined)
          assert.equal(unpinned.autoCut, pinned.autoCut)
          assert.equal(unpinned.tailReserveMessages, pinned.tailReserveMessages)
          await page.reload()
          await cutoff.waitFor()
          assert.equal(await cutoff.inputValue(), '')
          assert.deepEqual(errors, [])
          await page.close()
        }
        console.log(`${engine} ${width}px: default, opt-out and custom reserve; pin, clear, save and reload passed without browser errors`)
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
