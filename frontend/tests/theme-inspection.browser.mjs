import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'
import { createServer } from 'vite'
import config from '../vite.config.ts'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', logLevel: 'warn',
  resolve: config.resolve,
  optimizeDeps: { entries: ['tests/theme-inspection.fixture.ts'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__theme-inspection', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__theme-inspection', `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><style>[data-component="Fixture"]{color:rgb(10,20,30);padding:8px}</style>${'<div data-component="Fixture">Private text</div>'.repeat(40)}<input value="private-value"><script type="module" src="/tests/theme-inspection.fixture.ts"></script>`))
})
await server.listen()
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    const browser = runtime.browser
    try {
      for (const width of [1100, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__theme-inspection`)
        await page.waitForFunction(() => !!window.themeInspectionFixture)
        const archive = await page.evaluate(() => window.themeInspectionFixture.roundTrip())
        assert.equal(archive.pack.globalCSSEnabled, false)
        assert.equal(archive.pack.assets[0].dataBase64, 'AAEC')
        assert.match(archive.pack.bundleId, /^[a-f0-9-]{36}$/)
        assert.equal(archive.restored.Test.enabled, false)
        assert.equal(archive.pack.components.Test.enabled, true)
        const result = await page.evaluate(() => {
          const fixture = window.themeInspectionFixture
          const rejected = action => { try { action(); return null } catch (error) { return error.message } }
          const observed = fixture.api.inspect({ selector: '[data-component="Fixture"]', properties: ['color', 'padding'], limit: 2 })
          const attribute = rejected(() => fixture.api.inspect({ selector: 'input[value^="private"]' }))
          const content = rejected(() => fixture.api.inspect({ selector: 'body', properties: ['content'] }))
          fixture.deny()
          const permission = rejected(() => fixture.api.inspect({ selector: 'body' }))
          fixture.dispose()
          const disposed = rejected(() => fixture.api.inspect({ selector: 'body' }))
          return { observed, attribute, content, permission, disposed }
        })
        assert.equal(result.observed.count, 40)
        assert.equal(result.observed.matches.length, 2)
        assert.equal(result.observed.matches[0].styles.color, 'rgb(10, 20, 30)')
        assert.equal(result.observed.matches[0].styles.padding, '8px')
        assert(result.observed.matches[0].visible && result.observed.matches[0].rect.width > 0)
        assert(!JSON.stringify(result.observed).includes('Private text'))
        assert.match(result.attribute, /INVALID_THEME_SELECTOR/)
        assert.match(result.content, /INVALID_THEME_STYLE_PROPERTY/)
        assert.equal(result.permission, 'Permission denied')
        assert.equal(result.disposed, 'Disposed')
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${name} ${width}: theme inspection, archives and TSX review rules passed`)
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
