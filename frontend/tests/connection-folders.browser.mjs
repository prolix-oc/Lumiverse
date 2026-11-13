import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Run with the repository's diagnostic Playwright install, or point
// PLAYWRIGHT_MODULE at an existing playwright(-core)/index.mjs.
const { chromium, firefox, webkit } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', plugins: [react()], logLevel: 'warn',
  optimizeDeps: { entries: ['tests/connection-folders.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}/src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__connection-folders', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__connection-folders', '<html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/connection-folders.fixture.tsx"></script></body></html>'))
})
await server.listen()
const browserType = process.env.CONNECTION_BROWSER === 'webkit' ? webkit : process.env.CONNECTION_BROWSER === 'firefox' ? firefox : chromium
const browser = await browserType.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
const mobile = process.env.CONNECTION_MOBILE === '1'
const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {})
const errors = []
page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
page.on('requestfailed', request => console.error(request.url(), request.failure()?.errorText))
const state = () => page.evaluate(() => window.connectionFixture.store.getState().connectionLibraries)
async function drag(from, to) {
  await from.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const a = await from.boundingBox(), b = await to.boundingBox()
  assert(a && b)
  if (mobile) {
    const cdp = await page.context().newCDPSession(page)
    const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    await page.waitForTimeout(230)
    for (let step = 1; step <= 15; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: start.x + (b.x + b.width / 2 - start.x) * step / 15,
        y: start.y + (b.y + b.height / 2 - start.y) * step / 15, id: 1,
      }] })
    }
    await page.waitForTimeout(50)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await page.waitForTimeout(100)
    return
  }
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2, { steps: 3 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 })
  await page.waitForTimeout(50)
  await page.mouse.up()
  await page.waitForTimeout(250)
}
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__connection-folders`)
  await page.locator('[data-sortable-folder="local"]').getByRole('button', { name: /^Local \d+$/ }).waitFor({ timeout: 60000 })
  await drag(page.locator('[data-sortable-folder=""]').getByRole('button', { name: /^Uncategorized \d+$/ }), page.locator('[data-sortable-folder="local"]').getByRole('button', { name: /^Local \d+$/ }))
  assert.deepEqual((await state()).llm.folderOrder, ['', 'local', 'remote'])
  assert.deepEqual((await state()).imageGen.folderOrder, ['local', 'remote', ''])
  await page.locator('[data-sortable-folder="remote"]').getByRole('button', { name: /^Remote \d+$/ }).focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(100)
  await page.keyboard.press('Space')
  assert.deepEqual((await state()).llm.folderOrder, ['', 'remote', 'local'])
  await page.getByRole('button', { name: 'Local 1', exact: true }).click()
  await drag(page.getByRole('button', { name: 'Move Alpha', exact: true }), page.getByRole('button', { name: 'Remote 1', exact: true }))
  assert.equal((await state()).llm.assignments.a, 'remote')
  await page.getByLabel('Draft Alpha').fill('Unsaved draft')
  const search = page.getByRole('searchbox')
  await search.fill('remote')
  await page.getByRole('button', { name: 'Use Alpha' }).waitFor()
  await page.getByRole('button', { name: 'Use Beta' }).waitFor()
  assert.equal(await page.getByLabel('Draft Alpha').inputValue(), 'Unsaved draft')
  assert.equal(await page.getByRole('button', { name: 'Use Gamma' }).count(), 0)
  await page.getByRole('button', { name: 'Remote 2', exact: true }).click()
  await search.fill('')
  assert.equal(await page.getByRole('button', { name: 'Use Alpha' }).count(), 0)
  await page.getByRole('button', { name: 'Remote 2', exact: true }).click()
  for (const [key, order] of [['ArrowDown', ['', 'local', 'remote']], ['ArrowUp', ['', 'remote', 'local']]]) {
    await page.locator('[data-sortable-folder="remote"]').getByRole('button', { name: /^Remote \d+$/ }).focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(100)
    await page.keyboard.press(key)
    await page.waitForTimeout(100)
    await page.keyboard.press('Space')
    assert.deepEqual((await state()).llm.folderOrder, order)
    await page.waitForTimeout(250)
  }
  assert.equal(await page.getByLabel('Draft Alpha').inputValue(), 'Unsaved draft')
  await page.getByRole('button', { name: 'Choose connection' }).click()
  assert.deepEqual(await page.getByRole('listbox').getByRole('group').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Uncategorized', 'Remote'])
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.connectionFixture.flush())
  await page.reload()
  await page.locator('[data-sortable-folder="local"]').getByRole('button', { name: /^Local \d+$/ }).waitFor()
  assert.deepEqual((await state()).llm.folderOrder, ['', 'remote', 'local'])
  assert.equal((await state()).llm.assignments.a, 'remote')
  assert.equal(await page.evaluate(() => window.connectionFixture.store.getState().activeProfileId), 'a')
  await page.getByRole('button', { name: 'Rename Remote', exact: true }).click()
  await page.getByPlaceholder('Folder name...').fill('Hosted')
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click()
  assert.equal((await state()).llm.folders.find(folder => folder.id === 'remote').name, 'Hosted')
  assert.equal((await state()).llm.assignments.a, 'remote')
  await page.getByRole('button', { name: 'Delete Hosted', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  assert.equal((await state()).llm.assignments.a, undefined)
  assert.equal((await state()).llm.assignments.b, undefined)
  await page.getByRole('button', { name: /^Uncategorized \d+$/ }).click()
  await page.getByRole('button', { name: 'New Folder', exact: true }).click()
  await page.getByPlaceholder('Folder name...').fill('Empty')
  await page.getByPlaceholder('Folder name...').press('Enter')
  assert((await state()).llm.folders.some(folder => folder.name === 'Empty'))
  assert.equal((await state()).imageGen.folders.length, 2)
  assert.equal(await page.evaluate(() => window.connectionFixture.store.getState().activeProfileId), 'a')
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections), {})
  await page.getByRole('button', { name: 'Choose connection' }).click()
  await page.getByRole('option', { name: /Beta/ }).click()
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections.llm), ['b'])
  await page.getByText('Recently Used', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Use Beta', exact: true }).count(), 2)
  await page.getByRole('button', { name: 'Choose connection' }).click()
  assert.equal(await page.getByRole('option', { name: /Beta/ }).count(), 2)
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.connectionFixture.flush())
  await page.reload()
  await page.getByText('Recently Used', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections.llm), ['b'])
  const quickUrl = new URL(page.url())
  quickUrl.searchParams.set('picker', 'quick')
  await page.goto(quickUrl.href)
  await page.getByRole('searchbox').fill('model-a')
  await page.getByRole('button', { name: /Alpha/ }).click()
  assert.equal(await page.evaluate(() => window.connectionFixture.store.getState().activeProfileId), 'a')
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections.llm), ['a', 'b'])
  for (const kind of ['imageGen', 'stt', 'tts', 'decision', 'embedding']) {
    const typedUrl = new URL(page.url())
    typedUrl.search = `?kind=${kind}`
    await page.goto(typedUrl.href)
    await page.getByRole('button', { name: 'Choose connection' }).click()
    assert.deepEqual(await page.getByRole('listbox').getByRole('group').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Local', 'Remote', 'Uncategorized'])
    await page.getByRole('option', { name: /Beta/ }).click()
    assert.deepEqual(await page.evaluate(kind => window.connectionFixture.store.getState().recentConnections[kind], kind), ['b'])
    await page.getByText('Recently Used', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections.llm), ['a', 'b'])
    if (kind === 'embedding') assert.equal(await page.getByLabel('Selected model').textContent(), 'model-b')
    await page.evaluate(() => window.connectionFixture.flush())
  }
  await page.evaluate(async () => {
    const store = window.connectionFixture.store.getState()
    store.setSetting('connectionLibraries', { ...store.connectionLibraries,
      llm: { ...store.connectionLibraries.llm, assignments: { a: 'local' } } })
    await window.connectionFixture.flush()
  })
  const rouletteUrl = new URL(page.url())
  rouletteUrl.search = '?picker=roulette'
  await page.goto(rouletteUrl.href)
  await page.getByPlaceholder('Connection name').fill('My roulette')
  await page.getByRole('button', { name: 'Roulette profiles', exact: true }).click()
  await page.getByRole('listbox').getByRole('group', { name: 'Local', exact: true }).waitFor()
  await page.getByRole('option', { name: /Alpha/ }).click()
  await page.getByRole('option', { name: /Beta/ }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved roulette').textContent()).metadata.connection_roulette.connection_ids, ['a', 'b'])
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.store.getState().recentConnections.llm), ['a', 'b'])
  const fullUrl = new URL(page.url())
  fullUrl.search = '?picker=full'
  await page.goto(fullUrl.href)
  await page.locator('[data-component="ConnectionsPicker"]').waitFor()
  await page.getByTitle('Variant C').click()
  await page.getByText('All Connections', { exact: true }).waitFor()
  await page.getByTitle('Variant B').click()
  await page.getByTitle('Variant A').click()
  await page.getByTitle('Variant B').click()
  assert.deepEqual(errors, [])
  if (process.env.CONNECTION_SCREENSHOT) await page.screenshot({ path: process.env.CONNECTION_SCREENSHOT, fullPage: true })
  console.log('PASS: folder CRUD, draft preservation, pointer and keyboard order, cross-folder drag, search, picker order, recents, six connection kinds, type isolation, settings reload and active selection')
} catch (error) {
  console.error('Browser body:', await page.locator('body').innerText())
  throw error
} finally {
  await browser.close()
  await server.close()
}
