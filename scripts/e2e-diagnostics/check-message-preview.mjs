// Real native preview, display hooks, resolver registry and regex pipeline;
// controlled store/HTTP boundaries. No live server, credentials or personal data.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { build } = require('esbuild')
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({
  absWorkingDir: root, entryPoints: ['frontend/tests/message-preview.fixture.tsx'], outfile: 'message-preview-fixture.js',
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'import.meta.url': '"http://fixture.test/unused-worker.js"' },
  plugins: [{ name: 'preview-boundaries', setup(build) {
    build.onResolve({ filter: /^@\/store$/ }, args => ({ path: args.path, namespace: 'fixture-store' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture-store' }, () => ({ contents: 'import {create} from "zustand"; export const useStore=create(()=>({}));', loader: 'js', resolveDir: root + '/frontend' }))
    build.onResolve({ filter: /^@\/i18n$/ }, args => ({ path: args.path, namespace: 'fixture-i18n' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: 'import i18n from "i18next";import {initReactI18next} from "react-i18next";i18n.use(initReactI18next).init({lng:"en",resources:{en:{chat:{assistantFallback:"Assistant"}}},initImmediate:false,interpolation:{escapeValue:false}});export default i18n; export const changeUiLanguage=async()=>{};', loader: 'js', resolveDir: root + '/frontend' }))
    build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'unused-worker' }))
    build.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default "unused-fixture-worker"', loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || ''
const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
:root{--lumiverse-text:#eee;--lumiverse-bg:#19181f;--lumiverse-border:#444;--app-interactive-safe-top:0px}body{margin:0;background:var(--lumiverse-bg);color:var(--lumiverse-text)}#preview{margin:var(--app-interactive-safe-top) 12px 12px;padding:12px;overflow-wrap:anywhere}@media(max-width:680px){:root{--app-interactive-safe-top:47px}}</style></head><body><div id="preview"></div><script src="/fixture.js"></script></body></html>`
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? js : html) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
if (process.argv.includes('--serve')) { console.log(`Preview fixture: ${url}`); await new Promise(() => {}) }
try {
  for (const name of (process.env.PREVIEW_BROWSERS || 'chromium,webkit').split(',')) {
    const browser = await playwright[name].launch()
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        let backendCalls = 0
        await page.route('**/api/v1/chats/chat/display-preprocess', async route => {
          const body = route.request().postDataJSON()
          await route.fulfill({ json: { items: body.items.map(item => ({ content: item.rawContent })) } })
        })
        await page.route('**/api/v1/regex-scripts/apply', async route => {
          backendCalls += 1
          const rendered = await page.evaluate(() => window.messagePreviewFixture.rendered)
          await route.fulfill({ json: { result: rendered, cacheable: true, touched_vars: [] } })
        })
        await page.goto(url)
        await page.getByRole('heading', { name: 'Resolved island' }).waitFor()
        assert.equal(await page.locator('#preview').innerText().then(text => text.includes('Before')), false, 'Range excludes adjacent prose')
        const action = page.getByRole('button', { name: 'Continue', exact: true })
        assert.equal(await action.getAttribute('aria-disabled'), 'true')
        await action.dispatchEvent('click', { bubbles: true, composed: true })
        await action.dispatchEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
        assert.equal(await page.evaluate(() => window.messagePreviewFixture.actionCount()), 0)
        await page.getByText('Details', { exact: true }).click()
        assert.equal(await page.locator('details').getAttribute('open'), '')
        if (width === 390) assert.ok((await page.getByRole('heading', { name: 'Resolved island' }).boundingBox()).y >= 47)
        await page.evaluate(() => window.messagePreviewFixture.swipe(1))
        await page.getByText('Second swipe', { exact: true }).waitFor()
        await page.evaluate(() => window.messagePreviewFixture.range())
        await page.getByRole('heading', { name: 'Resolved island' }).waitFor()
        const backendResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/regex-scripts/apply'))
        await page.evaluate(() => window.messagePreviewFixture.backend())
        await backendResponse
        await page.waitForFunction(() => !document.querySelector('[data-display-pending]'))
        await page.getByRole('heading', { name: 'Resolved island' }).waitFor()
        assert.ok(backendCalls > 0, 'Backend display regex path exercised')
        await page.evaluate(() => window.messagePreviewFixture.navigate())
        await page.getByRole('status').filter({ hasText: 'unavailable' }).waitFor()
        await page.evaluate(() => window.messagePreviewFixture.restore())
        await page.getByRole('heading', { name: 'Resolved island' }).waitFor()
        await page.evaluate(() => window.messagePreviewFixture.unmount())
        assert.equal(await page.locator('[data-component="MessageContent"]').count(), 0)
        await page.evaluate(() => window.messagePreviewFixture.remount())
        await page.getByRole('heading', { name: 'Resolved island' }).waitFor()
        await page.evaluate(() => window.messagePreviewFixture.remove())
        await page.getByRole('status').filter({ hasText: 'unavailable' }).waitFor()
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${name} ${width}px: owned/backend display, source range, swipe change, disabled actions, disclosures, navigation and remount passed`)
      }
    } finally { await browser.close() }
  }
} finally { server.close() }
