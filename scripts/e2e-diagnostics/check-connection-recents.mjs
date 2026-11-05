// Real settings hydration, checkbox and all native connection surfaces; isolated HTTP storage.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const { default: react } = await import(require.resolve('@vitejs/plugin-react'))
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const kinds = ['llm', 'imageGen', 'stt', 'tts', 'decision', 'embedding']
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', plugins: [react()], logLevel: 'warn',
  optimizeDeps: { entries: ['tests/connection-folders.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__connection-recents', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__connection-recents', '<html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/connection-folders.fixture.tsx"></script></body></html>'))
})
await server.listen()
try {
  const base = `http://127.0.0.1:${server.httpServer.address().port}/__connection-recents`
  for (const engine of (process.env.CONNECTION_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' })
        page.setDefaultTimeout(30000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.route('**/api/v1/personas/*/avatar**', route => route.fulfill({
          contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#aac"/></svg>',
        }))
        await page.addInitScript(kinds => {
          const key = 'connection-folders-fixture-settings'
          if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
            activeProfileId: 'a', recentConnections: Object.fromEntries(kinds.map(kind => [kind, ['b', 'a']])),
            recentPersonaIds: ['two', 'one'],
          }))
        }, kinds)
        const visit = async query => {
          await page.goto(`${base}?${query}`)
          await page.waitForFunction(() => window.connectionFixture?.store.getState().fullSettingsLoaded)
        }
        const preference = () => page.getByRole('checkbox', { name: /^Show recently used connections/ })
        const setVisible = async enabled => {
          await visit('settings=display')
          await preference().waitFor()
          await preference().setChecked(enabled)
          await page.evaluate(() => window.connectionFixture.flush())
          await page.reload()
          await preference().waitFor()
          assert.equal(await preference().isChecked(), enabled, 'preference survives reload')
        }
        await visit('settings=display')
        await preference().waitFor()
        assert.equal(await preference().isChecked(), true, 'legacy accounts default to visible')
        for (const enabled of [true, false, true]) {
          console.log(`${engine} ${width}px: checking recently used ${enabled ? 'shown' : 'hidden'}`)
          await setVisible(enabled)
          for (const kind of kinds) {
            await visit(`kind=${kind}`)
            const recent = page.getByText('Recently Used', { exact: true })
            if (enabled) await recent.waitFor()
            else assert.equal(await recent.count(), 0, `${kind} manager hides the recent group`)
            await page.getByRole('button', { name: 'Choose connection', exact: true }).click()
            assert.equal(await page.getByRole('group', { name: 'Recently Used', exact: true }).count(), enabled ? 1 : 0, `${kind} select respects the preference`)
            // Selecting while hidden still records history and updates the real selection/model.
            await page.getByRole('option', { name: /Gamma/ }).last().click()
            await page.waitForFunction(kind => window.connectionFixture.store.getState().recentConnections[kind][0] === 'c', kind)
            if (kind === 'embedding') assert.equal(await page.getByLabel('Selected model').textContent(), 'model-c')
            await page.evaluate(() => window.connectionFixture.flush())
          }
          await visit('picker=quick')
          if (enabled) await page.getByText('Recently Used', { exact: true }).waitFor()
          else assert.equal(await page.getByText('Recently Used', { exact: true }).count(), 0, 'quick picker hides recent group')
          await visit('picker=full')
          await page.locator('[data-component="ConnectionsPicker"]').waitFor()
          for (const variant of ['A', 'B', 'C']) {
            await page.getByTitle(`Variant ${variant}`, { exact: true }).click()
            if (variant === 'A') {
              assert.equal(await page.getByRole('button', { name: 'Recent', exact: true }).count(), enabled ? 1 : 0, 'provider picker hides the Recent tab')
            } else {
              assert.equal(await page.getByRole('heading', { name: 'Recent', exact: true }).count(), enabled ? 1 : 0, `${variant} picker hides the Recent section`)
            }
          }
        }
        assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections),
          Object.fromEntries(kinds.map(kind => [kind, ['c', 'b', 'a']])), 'hiding retains history for every connection kind')
        // The existing picker-specific preference still applies when the global preference is on.
        await page.evaluate(() => {
          const state = window.connectionFixture.store.getState()
          state.setSetting('connectionsPickerSettings', { ...state.connectionsPickerSettings, showRecent: false })
        })
        for (const variant of ['A', 'B', 'C']) {
          await page.getByTitle(`Variant ${variant}`, { exact: true }).click()
          assert.equal(await page.getByRole('button', { name: 'Recent', exact: true }).count(), 0)
          assert.equal(await page.getByRole('heading', { name: 'Recent', exact: true }).count(), 0)
        }
        for (const enabled of [true, false, true]) {
          await visit('settings=display')
          const personas = page.getByRole('checkbox', { name: /^Show recently used personas/ })
          await personas.setChecked(enabled)
          await page.evaluate(() => window.connectionFixture.flush())
          await page.reload()
          await personas.waitFor()
          assert.equal(await personas.isChecked(), enabled)
          assert.equal(await preference().isChecked(), true, 'persona visibility is independent of connection visibility')
          await visit('personas=manager')
          await page.getByText('Persona one', { exact: true }).first().waitFor()
          assert.equal(await page.getByText('Recently used', { exact: true }).count(), enabled ? 1 : 0)
          assert.equal(await page.getByText('Persona one', { exact: true }).count(), enabled ? 2 : 1, 'hidden shortcuts retain canonical persona cards')
          assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentPersonaIds), ['two', 'one'])
        }
        assert.deepEqual(errors, [], 'no browser runtime or console errors')
        console.log(`${engine} ${width}px: default, checkbox/reload, six connection kinds, hidden selections, embedding model, quick picker and variants A/B/C passed`)
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
