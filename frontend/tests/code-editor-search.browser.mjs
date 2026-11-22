import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', logLevel: 'warn',
  resolve: config.resolve,
  optimizeDeps: { entries: ['tests/code-editor-search.fixture.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/tests/code-editor-search.fixture.tsx"></script>'))
})
await server.listen()
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const platform of ['Win32', 'MacIntel']) {
        for (const tsx of [false, true]) {
          for (const dock of [false, true]) {
            const page = await runtime.browser.newPage({ viewport: { width: dock ? 390 : 1280, height: 800 } })
            const errors = []
            page.on('pageerror', error => errors.push(error.message))
            await page.addInitScript(platform => Object.defineProperty(navigator, 'platform', { value: platform }), platform)
            const params = new URLSearchParams({ ...(tsx ? { tsx: '1' } : {}), ...(dock ? { dock: '1' } : {}) })
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${params}`)
            const editor = page.locator('.cm-content')
            await editor.waitFor()
            const mod = platform === 'MacIntel' ? 'Meta' : 'Control'
            const term = tsx ? 'needle' : 'red'
            const initial = await page.evaluate(() => window.codeEditorFixture.value)
            const first = initial.indexOf(term)
            const second = initial.lastIndexOf(term)
            const selection = () => page.evaluate(() => window.codeEditorFixture.selection)
            await page.evaluate(({ from, to }) => window.codeEditorFixture.select(from, to), { from: first, to: first + term.length })
            await page.keyboard.press(`${mod}+f`)
            const find = page.locator('.cm-search input[name="search"]')
            assert.equal(await find.count(), 1, 'find shortcut must open the editor search panel')
            assert.equal(await find.inputValue(), term, 'selected code seeds the query')
            assert(await find.evaluate(node => document.activeElement === node), 'find field receives focus')

            await find.press('Enter')
            assert.deepEqual(await selection(), { from: second, to: second + term.length })
            await find.press('Shift+Enter')
            assert.deepEqual(await selection(), { from: first, to: first + term.length })
            await find.press('F3')
            assert.deepEqual(await selection(), { from: second, to: second + term.length })
            await find.press('Shift+F3')
            assert.deepEqual(await selection(), { from: first, to: first + term.length })
            await find.press(`${mod}+g`)
            assert.deepEqual(await selection(), { from: second, to: second + term.length })
            await find.press(`${mod}+Shift+g`)
            assert.deepEqual(await selection(), { from: first, to: first + term.length })
            await find.press(`${mod}+f`)
            assert.equal(await find.count(), 1, 'reopening search reuses the panel')
            assert(await page.locator('.cm-search').evaluate(node => node.scrollWidth <= node.clientWidth), 'search controls fit a narrow editor')
            if (platform === 'Win32' && !tsx) {
              await page.waitForFunction(() => {
                for (let node = document.querySelector('[data-editor-surface]'); node; node = node.parentElement) {
                  if (Number(getComputedStyle(node).opacity) < 1) return false
                }
                return true
              })
              await page.screenshot({ path: `/tmp/code-editor-search-${name}-${dock ? 'narrow' : 'modal'}.png` })
            }

            const replace = page.locator('.cm-search input[name="replace"]')
            await replace.pressSequentially('changed')
            await replace.press('Enter')
            assert.equal(await page.evaluate(() => window.codeEditorFixture.value), initial.replace(term, 'changed'))
            await find.press('Escape')
            assert.equal(await page.locator('.cm-search').count(), 0)
            assert.equal(await editor.count(), 1, 'Escape closes search before the modal')
            assert(await editor.evaluate(node => document.activeElement === node), 'closing search restores editor focus')
            await page.keyboard.press(`${mod}+z`)
            assert.equal(await page.evaluate(() => window.codeEditorFixture.value), initial, 'replacement is undoable')
            if (platform === 'MacIntel') await page.keyboard.press('Control+k')
            await page.evaluate(() => window.codeEditorFixture.select(0))
            await page.keyboard.press(`${mod}+f`)
            await editor.focus()
            await page.keyboard.press('Escape')
            assert.equal(await page.locator('.cm-search').count(), 0, 'Escape also closes search from the code surface')
            assert.equal(await editor.count(), 1)
            assert.deepEqual(await page.evaluate(() => window.codeEditorFixture.bubbled), [], 'handled editor shortcuts must not reach document listeners')
            assert.equal(await page.evaluate(() => window.codeEditorFixture.appFinds), 0)

            if (dock) {
              await page.getByRole('textbox', { name: 'Outside editor' }).focus()
              await page.keyboard.press(`${mod}+f`)
              assert.equal(await page.evaluate(() => window.codeEditorFixture.appFinds), 1, 'outside find remains available')
              assert.equal(await page.locator('.cm-search').count(), 0)
            } else {
              await page.evaluate(() => window.codeEditorFixture.select(0))
              await page.keyboard.press('Escape')
              await editor.waitFor({ state: 'detached' })
            }
            assert.deepEqual(errors, [])
            console.log(`${name} ${platform} ${tsx ? 'TSX' : 'CSS'} ${dock ? 'dock' : 'modal'}: search, navigation, replace, undo, shortcut isolation passed`)
            await page.close()
          }
        }
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
