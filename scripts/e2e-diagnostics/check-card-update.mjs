// Run against a disposable Lumiverse server serving the checked frontend build.
// CARD_UPDATE_BASE_URL, CARD_UPDATE_USERNAME and CARD_UPDATE_PASSWORD are required.
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { request } from 'playwright'
import { launchTestBrowser } from './browser-runtime.mjs'

const base = process.env.CARD_UPDATE_BASE_URL
const username = process.env.CARD_UPDATE_USERNAME
const password = process.env.CARD_UPDATE_PASSWORD
assert.ok(base && username && password, 'Provide disposable-server URL and credentials in CARD_UPDATE_* variables')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64')
const cardFile = data => {
  const payload = Buffer.from('ccv3\0' + Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data })).toString('base64'))
  const type = Buffer.from('tEXt')
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, payload])))
  return { name: `selective-update-${data.name}.png`, mimeType: 'image/png', buffer: Buffer.concat([png.subarray(0, -12), length, type, payload, crc, png.subarray(-12)]) }
}

const api = await request.newContext({ baseURL: base })
try {
  const login = await api.post('/api/auth/sign-in/username', { headers: { Origin: base }, data: { username, password } })
  assert.equal(login.status(), 200)
  assert.equal((await api.put('/api/v1/settings/characterFolders', { data: { value: [] } })).status(), 200)
  const storageState = await api.storageState()

  for (const engine of (process.env.CARD_UPDATE_BROWSERS?.split(',') ?? ['chromium', 'firefox', 'webkit'])) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', storageState })
        page.setDefaultTimeout(12000)
        const errors = []
        let navigating = false
        let unloadCancellations = 0
        // WebKit's visibility-change import poll is rejected as its document
        // unloads. Exempt only that endpoint during deliberate test navigation.
        page.on('pageerror', error => {
          if (engine === 'webkit' && navigating && error.message.includes('/api/v1/user-data/import due to access control checks.')) {
            unloadCancellations++
            return
          }
          errors.push(error.message)
        })
        page.on('console', message => {
          if (message.type() !== 'error') return
          errors.push(message.text() + ' ' + message.location().url)
        })
        const navigate = async action => {
          await page.waitForLoadState('networkidle')
          navigating = true
          try { await action(); await page.waitForLoadState('networkidle') }
          finally { navigating = false }
        }
        const name = `Card review ${engine} ${width} ${Date.now()}`
        const created = await page.request.post(`${base}/api/v1/characters`, { data: {
          name, description: 'Local biography', first_mes: 'Old main', alternate_greetings: ['Local alternate'], tags: ['local'],
          extensions: { greeting_tools: { mainGreeting: { id: 'main', title: 'Main title' }, indexMap: { 0: 'local' }, greetings: { local: { title: 'Local title' } } } },
        } })
        assert.equal(created.status(), 201)
        const original = await created.json()
        const avatar = await page.request.post(`${base}/api/v1/characters/${original.id}/avatar`, { multipart: { avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: png } } })
        assert.equal(avatar.status(), 200)
        const incoming = { name, description: 'Author biography', first_mes: 'New main', alternate_greetings: ['Local alternate', 'New alternate'], tags: ['author'] }
        const read = async () => {
          const response = await page.request.get(`${base}/api/v1/characters/${original.id}`)
          assert.equal(response.status(), 200)
          return response.json()
        }
        const openBrowser = async () => {
          await navigate(() => page.goto(base))
          await page.locator('button[class*="_drawerTab_"]').click()
          await page.locator('[data-tab-id="characters"]').click()
          await page.getByText(name, { exact: true }).first().waitFor()
        }
        const upload = () => page.locator('input[type=file][accept=".json,.png,.charx,.jpg,.jpeg"]').setInputFiles(cardFile(incoming))
        const modal = page.locator('[data-component="CardUpdateModal"]')
        const apply = async () => {
          const response = page.waitForResponse(response => response.url().endsWith('/apply-card-update') && response.request().method() === 'POST')
          await modal.getByRole('button', { name: /^Apply Updates/ }).click()
          assert.equal((await response).status(), 200)
          await modal.waitFor({ state: 'hidden' })
        }
        await openBrowser()
        await upload()
        await modal.waitFor()
        await modal.getByRole('button', { name: 'Greetings only', exact: true }).click()
        await modal.locator('select').filter({ has: page.locator('option[value="replace_and_demote"]') }).selectOption('replace_and_demote')
        const bounds = await modal.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 901, 'Dialog fits viewport')
        assert.ok(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'No horizontal dialog overflow')
        if (process.env.CARD_UPDATE_SCREENSHOTS) await page.screenshot({ path: `${process.env.CARD_UPDATE_SCREENSHOTS}/${engine}-${width}.png`, animations: 'disabled' })
        await apply()
        let saved = await read()
        assert.equal(saved.description, 'Local biography')
        assert.deepEqual(saved.tags, ['local'])
        assert.equal(saved.first_mes, 'New main')
        assert.deepEqual(saved.alternate_greetings, ['Local alternate', 'New alternate', 'Old main'])
        assert.equal(saved.extensions.greeting_tools.indexMap['2'], 'main')
        assert.equal(saved.extensions.greeting_tools.greetings.main.title, 'Main title')

        // Editor: a pending local edit must be flushed before the preview/update.
        await openBrowser()
        const card = page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByTitle('Edit character', { exact: true }) })
        await card.getByTitle('Edit character', { exact: true }).click()
        const description = page.getByPlaceholder('Description...', { exact: true })
        await description.fill('Pending local biography')
        // Set files directly, before the two-second editor debounce can fire.
        await page.locator('input[type=file][accept=".json,application/json,.png,image/png,.charx,.jpg,.jpeg"]').setInputFiles(cardFile({ ...incoming, first_mes: 'Editor main' }))
        await modal.waitFor()
        assert.equal((await read()).description, 'Pending local biography')
        await modal.getByRole('button', { name: 'Greetings only', exact: true }).click()
        await apply()
        assert.equal((await read()).description, 'Pending local biography')
        assert.equal((await read()).first_mes, 'Editor main')
        await description.waitFor()
        assert.equal(await description.inputValue(), 'Pending local biography')
        await navigate(() => page.reload())
        saved = await read()
        assert.equal(saved.first_mes, 'Editor main')

        // The duplicate-card escape hatch must create a separate character.
        await openBrowser()
        await upload()
        await modal.waitFor()
        const imported = page.waitForResponse(response => response.url().endsWith('/characters/import') && response.request().method() === 'POST')
        await modal.getByRole('button', { name: 'Import as New', exact: true }).click()
        const importedResponse = await imported
        assert.equal(importedResponse.status(), 201)
        const importedId = (await importedResponse.json()).character.id
        assert.notEqual(importedId, original.id)
        await modal.waitFor({ state: 'hidden' })
        assert.deepEqual(errors, [])
        console.log(`${engine} ${width}px: browser greetings merge, editor pending-save preservation, reload, import-as-new and viewport checks passed without unexpected browser errors`)
        if (unloadCancellations) console.log(`${engine}: ${unloadCancellations} expected import-recovery unload cancellations`)
        await page.close()
        await api.delete(`/api/v1/characters/${original.id}`)
        await api.delete(`/api/v1/characters/${importedId}`)
      }
    } finally { await runtime.close() }
  }

} finally { await api.dispose() }
