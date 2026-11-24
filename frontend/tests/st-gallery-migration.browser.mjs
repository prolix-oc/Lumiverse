import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), appType: 'custom', logLevel: 'warn',
  resolve: config.resolve,
  optimizeDeps: { entries: ['tests/st-gallery-migration.fixture.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/tests/st-gallery-migration.fixture.tsx"></script>'))
})
await server.listen()
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
        await page.getByRole('button', { name: 'Validate', exact: true }).click()
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        const gallery = page.getByRole('checkbox', { name: /^Galleries & Media/ })
        const characters = page.getByRole('checkbox', { name: 'Characters', exact: true })
        await gallery.waitFor()
        assert(await gallery.isChecked())
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'migration wizard fits the viewport')
        await characters.uncheck()
        assert.equal(await gallery.isChecked(), false, 'disabling characters disables gallery import')
        await gallery.check()
        assert(await characters.isChecked(), 'enabling galleries enables characters')
        assert(await gallery.isChecked())
        assert(await gallery.evaluate(node => {
          const box = node.closest('label').getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth
        }), 'gallery control fits mobile viewport')
        assert(await page.getByRole('button', { name: 'Next', exact: true }).evaluate(node => node.getBoundingClientRect().right <= innerWidth), 'Next fits the viewport')
        await page.screenshot({ path: `/tmp/pr552-${name}-${width}.png`, fullPage: true })
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await page.getByText('Galleries & Media', { exact: false }).waitFor()
        await page.getByRole('button', { name: 'Start Migration', exact: true }).click()
        await page.waitForFunction(() => window.migrationReview.request && window.migrationReview.phase === 'starting')
        assert.equal(await page.evaluate(() => window.migrationReview.request.scope.gallery), true)
        assert.equal(await page.evaluate(() => window.migrationReview.request.scope.characters), true)
        await page.evaluate(() => window.migrationReview.progress())
        await page.getByText('Importing galleries', { exact: false }).waitFor()
        await page.evaluate(() => window.migrationReview.complete())
        await page.getByText('Migration Complete', { exact: false }).waitFor()
        assert.deepEqual(errors, [])
        console.log(`${name} ${runtime.browser.version()} ${width}px: scope dependencies, execution payload, gallery progress and completion passed`)
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
