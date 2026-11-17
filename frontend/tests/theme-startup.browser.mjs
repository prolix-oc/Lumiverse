import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', logLevel: 'warn',
  resolve: config.resolve,
  optimizeDeps: { entries: ['tests/theme-startup.fixture.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (!['/', '/__theme-startup'].includes(req.url.split('?')[0])) return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><link rel="icon" href="data:,"><style>[data-shell]{color:rgb(10,20,30);padding:1px}</style><div id="root"></div><script type="module" src="/tests/theme-startup.fixture.tsx"></script>'))
})
await server.listen()
const startup = {
  theme: { id: 'saved', name: 'Saved', mode: 'dark', accent: { h: 120, s: 50, l: 50 }, radiusScale: 1, fontScale: 1, enableGlass: false },
  customCSS: { css: '[data-shell] { color: rgb(210, 20, 50) }', enabled: true, revision: 1, bundleId: 'fixture-bundle' },
  componentOverrides: { Test: { css: '[data-shell] { padding: 29px }', tsx: '', enabled: true } },
}
const pageData = { data: [], total: 0, limit: 100, offset: 0 }
const connections = { connections: pageData, providers: [] }
const broadPayload = {
  startupSettings: { theme: null, customCSS: { css: '', enabled: false } },
  recentChats: pageData, llm: connections, stt: connections, tts: connections, imageGen: connections,
  packs: pageData, personas: pageData, regexScripts: pageData,
  council: { settings: { members: [] }, tools: [] }, spindle: { extensions: [], tools: [] },
}
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const [path, safe] of [['/', false], ['/__theme-startup', false], ['/__theme-startup?safe-theme=1', true], ['/__theme-startup?server-safe=1', true], ['/__theme-startup?startup-fails=1', false]]) {
        const page = await runtime.browser.newPage()
        const errors = []
        const requests = []
        page.on('pageerror', error => errors.push(error.message))
        let releaseStartup
        let releaseBroadBootstrap
        const startupGate = new Promise(resolve => { releaseStartup = resolve })
        const broadGate = new Promise(resolve => { releaseBroadBootstrap = resolve })
        await page.route('**/api/v1/**', async route => {
          const url = new URL(route.request().url())
          requests.push(url.pathname)
          if (url.pathname.endsWith('/runtime-config')) return route.fulfill({ json: { safeThemeMode: path.includes('server-safe') } })
          if (url.pathname.endsWith('/bootstrap/startup')) {
            await startupGate
            if (path.includes('startup-fails')) return route.fulfill({ status: 404, json: { error: 'Older server' } })
            return route.fulfill({ json: startup })
          }
          if (url.pathname.endsWith('/bootstrap') || url.pathname.endsWith('/bootstrap/landing')) {
            await broadGate
            // A later startup source must never replace the already-hydrated theme.
            return route.fulfill({ json: { payload: broadPayload, errors: {} } })
          }
          if (url.pathname.endsWith('/settings')) return route.fulfill({ json: Object.entries(startup).map(([key, value]) => ({ key, value, updated_at: 1 })) })
          return route.fulfill({ json: { jobs: [] } })
        })
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${path}`, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => !!window.themeStartupFixture)
        await page.waitForSelector('[data-startup]')
        assert.equal(await page.locator('[data-shell]').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode')), null, 'startup must not apply the default theme first')
        const releasedAt = Date.now()
        releaseStartup()
        await page.waitForSelector('[data-shell]')
        const samples = await page.evaluate(() => window.themeStartupFixture.observations)
        assert(samples.length > 0)
        for (const sample of samples) {
          assert.equal(sample.color, safe ? 'rgb(10, 20, 30)' : 'rgb(210, 20, 50)')
          assert.equal(sample.padding, safe ? '1px' : '29px')
          assert.equal(sample.css === '', safe)
        }
        assert.equal(requests.includes('/api/v1/settings'), path.includes('startup-fails'), 'full settings is needed only for the failed startup fallback')
        assert(requests.includes('/api/v1/bootstrap'), 'broad bootstrap remains in flight independently')
        releaseBroadBootstrap()
        await page.waitForFunction(() => window.themeStartupFixture.store.getState().fullSettingsLoaded)
        assert.equal(await page.locator('[data-shell]').evaluate(el => getComputedStyle(el).color), safe ? 'rgb(10, 20, 30)' : 'rgb(210, 20, 50)')
        assert.deepEqual(errors, [])
        console.log(`${name} ${path}: first shell paint used ${safe ? 'safe' : 'saved'} styling before broad bootstrap (${Date.now() - releasedAt} ms including fallback completion)`)
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
