// Real login, settings persistence and lazy locales, with isolated HTTP accounts.
// Start Vite in unbundled mode first; UI_LANGUAGE_URL defaults to http://127.0.0.1:5173.
import assert from 'node:assert/strict'
import { launchTestBrowser } from './browser-runtime.mjs'

const base = process.env.UI_LANGUAGE_URL || 'http://127.0.0.1:5173'
const fixture = await fetch(`${base}/tests/ui-language.fixture.html`).then(response => {
  assert.ok(response.ok, 'Vite must serve the language fixture')
  return response.text()
})
assert.match(fixture, /\/tests\/ui-language\.fixture\.tsx/, 'Start Vite in unbundled mode so it serves the language fixture')

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const launched = await launchTestBrowser(engine)
  const { browser } = launched
  try {
    for (const width of [1280, 390]) {
      const accounts = new Map([['english', { uiLanguage: 'en' }], ['french', { uiLanguage: 'fr' }], ['legacy', {}]])
      const writes = []
      const errors = []
      const contexts = []
      const open = async (locale, cached = 'ko') => {
        const context = await browser.newContext({ locale, viewport: { width, height: 844 }, reducedMotion: 'reduce' })
        contexts.push(context)
        // Chromium classifies route-fulfilled documents separately from the
        // loopback Vite HMR socket. Allow that local development connection.
        if (engine === 'chromium') await context.grantPermissions(['local-network-access'], { origin: base })
        await context.addInitScript(cached => {
          if (!localStorage.getItem('fixture-initialized')) {
            localStorage.setItem('lumiverse-ui-language', cached)
            localStorage.setItem('fixture-initialized', 'true')
          }
        }, cached)
        let account = null
        await context.route('**/*', async route => {
          const request = route.request()
          const path = new URL(request.url()).pathname
          if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: fixture })
          const json = value => route.fulfill({ json: value })
          if (path === '/api/auth/sign-in/username') {
            account = request.postDataJSON().username
            assert.ok(accounts.has(account), 'only fixture accounts can sign in')
            return json({ user: { id: account, name: account, username: account, role: 'user' }, token: 'fixture' })
          }
          if (path === '/api/auth/get-session') return json(account ? { user: { id: account }, session: {} } : null)
          if (path === '/api/auth/sign-out') { account = null; return json({ success: true }) }
          if (path === '/api/v1/settings') {
            assert.ok(account, 'settings require an authenticated fixture account')
            const settings = accounts.get(account)
            if (request.method() === 'PUT') {
              const values = request.postDataJSON()
              writes.push({ account, values })
              Object.assign(settings, values)
            }
            return json(Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: 1 })))
          }
          if (path.startsWith('/api/')) return json([])
          return route.continue()
        })
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.goto(`${base}/login`)
        await page.locator('#lumiverse-login-language').waitFor()
        return page
      }
      const login = async (page, name) => {
        await page.locator('input[autocomplete="username"]').fill(name)
        await page.locator('input[autocomplete="current-password"]').fill('fixture-password')
        await page.locator('button[type="submit"]').click()
        await page.waitForFunction(() => document.querySelector('#settings-loaded')?.textContent === 'true')
      }
      const display = async (page, language) => {
        await page.waitForFunction(language => document.querySelector('#display-language')?.textContent === language, language)
        assert.equal(await page.locator('#lumiverse-ui-language').inputValue(), language)
      }
      try {
        const desktop = await open('fr-FR')
        assert.equal(await desktop.locator('#lumiverse-login-language').inputValue(), 'fr')
        assert.equal(await desktop.locator('#lumiverse-login-language option').count(), 8)
        assert.ok(await desktop.locator('#lumiverse-login-language option[value="ko"]').textContent() === '한국어')
        const bounds = await desktop.locator('#lumiverse-login-language').boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'picker fits the viewport')
        await desktop.locator('#lumiverse-login-language').selectOption('de')
        await desktop.waitForFunction(() => document.querySelector('details summary')?.textContent === 'Passwort vergessen?')
        await desktop.locator('details summary').click()
        assert.equal(await desktop.locator('details code').textContent(), 'bun run reset-password')
        assert.equal(await desktop.locator('details').getAttribute('open'), '')
        assert.equal(await desktop.evaluate(() => localStorage.getItem('lumiverse-ui-language')), 'ko')
        await desktop.reload()
        assert.equal(await desktop.locator('#lumiverse-login-language').inputValue(), 'de')

        await login(desktop, 'english')
        await display(desktop, 'en')
        assert.equal(writes.length, 0, 'hydrating a saved account language is read-only')
        assert.equal(await desktop.evaluate(() => localStorage.getItem('lumiverse-login-language')), 'de')
        await Promise.all([
          desktop.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT'),
          desktop.locator('#lumiverse-ui-language').selectOption('fr'),
        ])
        await display(desktop, 'fr')
        assert.equal(accounts.get('english').uiLanguage, 'fr')

        const second = await open('ja-JP', 'en')
        await login(second, 'english')
        await display(second, 'fr')
        accounts.get('english').uiLanguage = 'ko'
        await second.getByRole('button', { name: 'Refresh settings' }).click()
        await display(second, 'ko')
        assert.equal(writes.length, 1, 'server refresh cannot write the detected device locale back')

        await desktop.getByRole('button', { name: 'Sign out' }).click()
        await desktop.locator('#lumiverse-login-language').waitFor()
        assert.equal(await desktop.locator('#lumiverse-login-language').inputValue(), 'de')
        await login(desktop, 'french')
        await display(desktop, 'fr')
        await Promise.all([
          desktop.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT'),
          desktop.locator('#lumiverse-ui-language').selectOption('zh-TW'),
        ])
        await display(desktop, 'zh-TW')
        assert.equal(accounts.get('english').uiLanguage, 'ko', 'another account retains its own preference')

        const legacy = await open('fr-FR')
        await Promise.all([
          legacy.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT'),
          login(legacy, 'legacy'),
        ])
        await display(legacy, 'en')
        assert.equal(accounts.get('legacy').uiLanguage, 'en')
        const count = writes.length
        await Promise.all([
          legacy.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'GET'),
          legacy.getByRole('button', { name: 'Refresh settings' }).click(),
        ])
        assert.equal(writes.length, count, 'the compatibility default is written once')
        assert.deepEqual(errors, [])
        console.log(`${engine} ${width}px: login/recovery, reload, account persistence, second device, refresh and account isolation passed`)
      } finally { await Promise.all(contexts.map(context => context.close())) }
    }
  } finally { await launched.close() }
}
