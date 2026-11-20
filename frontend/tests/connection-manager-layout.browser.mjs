import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  optimizeDeps: { entries: ['tests/connection-manager-layout.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}/src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use('/__connection-manager-layout', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml('/__connection-manager-layout', '<html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/connection-manager-layout.fixture.tsx"></script></body></html>'))
})
await server.listen()
const browserType = process.env.CONNECTION_BROWSER === 'webkit' ? webkit : process.env.CONNECTION_BROWSER === 'firefox' ? firefox : chromium
const browser = await browserType.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
const mobile = process.env.CONNECTION_MOBILE === '1'
const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 830, height: 1100 } })
const errors = []
page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
page.on('requestfailed', request => console.error(request.url(), request.failure()?.errorText))
const state = () => page.evaluate(() => window.layoutFixture.store.getState().connectionLibraries)
async function drag(from, to, inspect) {
  await from.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const a = await from.boundingBox()
  assert(a)
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const cdp = mobile ? await page.context().newCDPSession(page) : null
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    await page.waitForTimeout(250)
  } else {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 6, start.y, { steps: 3 })
  }
  await to.waitFor({ state: 'visible' })
  const b = await to.boundingBox()
  assert(b)
  for (let step = 1; step <= 20; step++) {
    const point = { x: start.x + (b.x + b.width / 2 - start.x) * step / 20,
      y: start.y + (b.y + b.height / 2 - start.y) * step / 20 }
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] })
    else await page.mouse.move(point.x, point.y)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))))
    const preview = page.locator('[data-connection-drag-preview]')
    // Chromium may coalesce the first tiny touch move below its gesture slop.
    if ((!mobile || Math.abs(point.y - start.y) > 20) && await preview.count()) {
      const box = await preview.boundingBox()
      assert(Math.abs(box.y + box.height / 2 - point.y) < 4,
        `preview must track the pointer across folders: ${box.y + box.height / 2} vs ${point.y}`)
    }
  }
  await page.waitForTimeout(100)
  if (inspect) await inspect()
  assert.equal(await page.locator('main').evaluate(node => node.scrollLeft), 0, 'drag must not scroll the drawer sideways')
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else await page.mouse.up()
  await page.waitForTimeout(250)
}
async function chooseFolder(row, name) {
  const field = row.getByText('Folder', { exact: true }).locator('..')
  await field.getByRole('button').first().click()
  await field.getByRole('button', { name, exact: true }).last().click()
}
try {
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__connection-manager-layout`
  await page.goto(`${url}?scale=${process.env.CONNECTION_SCALE || 1}`)
  const row = page.locator('[id$="-connection-0"]')
  const recent = page.locator('[data-connection-placement="recent"]')
  await page.getByRole('button', { name: /^Uncategorized \d+$/ }).click({ timeout: 60000 })
  await row.getByTitle('Edit', { exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await recent.locator(':scope > div').count(), 4)
  assert.equal(await recent.getByTitle('Edit', { exact: true }).count(), 4)
  assert.equal(await recent.getByRole('button', { name: 'Drag to reorder', exact: true }).count(), 0, 'recent rows have no drag controls')
  assert.equal(await recent.locator(':scope > div').first().innerText(), await row.innerText())
  const newConnection = await page.getByRole('button', { name: 'New Connection', exact: true }).boundingBox()
  const newFolder = await page.getByRole('button', { name: 'New Folder', exact: true }).boundingBox()
  if (!mobile) assert(Math.abs(newConnection.y - newFolder.y) < 2, 'creation actions should share one row')
  const row2 = await page.locator('[id$="-connection-1"]').boundingBox()
  const row1 = await row.boundingBox()
  assert(row2.y - row1.y - row1.height <= 3, 'no extra folder-control row or large gap')
  await page.screenshot({ path: join(tmpdir(), `connection-manager-layout-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true })

  await page.getByRole('button', { name: 'New Folder', exact: true }).click()
  await page.getByPlaceholder('Folder name...').fill('Cloud')
  await page.getByPlaceholder('Folder name...').press('Enter')
  await page.getByRole('button', { name: 'Rename Cloud', exact: true }).click()
  assert.equal(await page.getByRole('dialog').count(), 0, 'folder rename must be inline')
  await page.getByPlaceholder('Folder name...').fill('Services')
  await page.getByPlaceholder('Folder name...').press('Enter')
  assert((await state()).llm.folders.some(folder => folder.name === 'Services'))

  await drag(row.getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByRole('button', { name: 'Local 0', exact: true }), async () => {
    assert.equal(await page.locator('[data-drop-target="true"]').count(), 1)
    const opacity = await page.locator('[data-connection-drag-preview]').evaluate(node => getComputedStyle(node.parentElement).opacity)
    assert(Number(opacity) < 0.7, 'dragged connection must be translucent')
    await page.screenshot({ path: join(tmpdir(), 'connection-manager-drag.png') })
  })
  assert.equal((await state()).llm.assignments['connection-0'], 'local')
  const second = page.locator('[id$="-connection-1"]')
  await drag(second.getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByRole('button', { name: 'Hosted 0', exact: true }))
  await drag(row.getByRole('button', { name: 'Vertex Argon 1 openai / model-0', exact: true }), page.getByRole('button', { name: 'Hosted 1', exact: true }))
  assert.equal((await state()).llm.assignments['connection-0'], 'hosted')
  const third = page.locator('[id$="-connection-2"]')
  const relativeTop = node => node.firstElementChild.getBoundingClientRect().top - node.closest('[data-sortable-folder]').getBoundingClientRect().top
  const offsetBefore = await second.evaluate(relativeTop)
  const persistedBefore = await state()
  await drag(third.getByRole('button', { name: 'Drag to reorder', exact: true }), second, async () => {
    assert.equal(await third.evaluate(node => node.closest('[data-sortable-folder]').dataset.sortableFolder), 'hosted')
    assert(await second.evaluate(relativeTop) > offsetBefore + 30, 'destination rows must make room BEFORE drop')
    assert.deepEqual(await state(), persistedBefore, 'hover preview must not save folder membership')
    await page.screenshot({ path: join(tmpdir(), 'connection-manager-cross-folder-preview.png') })
  })
  assert.equal((await state()).llm.assignments['connection-2'], 'hosted')

  // Reordering inside a folder uses row displacement, without lighting the
  // entire folder or jumping back to a folder target over the source slot.
  await drag(row.getByRole('button', { name: 'Drag to reorder', exact: true }), second, async () => {
    assert.equal(await page.locator('[data-drop-target="true"]').count(), 0)
    const transform = await second.locator(':scope > div').evaluate(node => getComputedStyle(node).transform)
    assert.notEqual(transform, 'none', 'same-folder neighbor must shift before release')
    await page.screenshot({ path: join(tmpdir(), 'connection-manager-within-folder-preview.png') })
  })

  const beforeCancel = await state()
  await drag(row.getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByRole('button', { name: 'Local 0', exact: true }), async () => {
    await page.keyboard.press('Escape')
  })
  assert.deepEqual(await state(), beforeCancel, 'cancel restores the original folders')

  // Native folder sorting moves the whole expanded group and shifts its neighbor.
  await drag(page.getByRole('button', { name: 'Hosted 3', exact: true }), page.getByRole('button', { name: 'Local 0', exact: true }), async () => {
    const transform = await page.locator('[data-sortable-folder="local"]').evaluate(node => getComputedStyle(node).transform)
    assert.notEqual(transform, 'none', 'neighbor folder must shift before release')
  })
  assert.deepEqual((await state()).llm.folderOrder.slice(0, 2), ['hosted', 'local'])
  const search = page.getByRole('searchbox')
  await search.fill('model-0')
  await drag(row.getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByRole('button', { name: 'Services 0', exact: true }))
  const services = (await state()).llm.folders.find(folder => folder.name === 'Services').id
  assert.equal((await state()).llm.assignments['connection-0'], services)
  await search.fill('')

  // A recent row is the actual card, but never a drag source or drop target.
  const beforeRecentDrag = await state()
  await drag(recent.getByRole('button', { name: 'Vertex Argon 1 openai / model-0', exact: true }), page.getByRole('button', { name: 'Local 0', exact: true }))
  assert.deepEqual(await state(), beforeRecentDrag)

  // Drafts survive searching/collapse and another placement's editor. A late
  // completion from one form cannot close another form.
  await row.getByTitle('Edit', { exact: true }).click()
  await row.getByPlaceholder('Connection name').fill('Unsaved canonical name')
  assert(await page.getByRole('button', { name: 'Delete Services', exact: true }).isDisabled())
  await search.fill('no matching connection')
  await search.fill('')
  assert.equal(await row.getByPlaceholder('Connection name').inputValue(), 'Unsaved canonical name')
  const recentFirst = recent.locator(':scope > div').first()
  await recentFirst.getByTitle('Edit', { exact: true }).click()
  assert.equal(await row.getByPlaceholder('Connection name').inputValue(), 'Unsaved canonical name')
  assert.equal(await recentFirst.getByPlaceholder('Connection name').count(), 0, 'a duplicate placement must return to the existing editor')
  await page.evaluate(() => { window.layoutFixture.holdNextUpdate = true })
  await row.getByRole('button', { name: 'Save', exact: true }).click()
  const recentSecond = recent.locator(':scope > div').nth(1)
  await recentSecond.getByTitle('Edit', { exact: true }).click()
  await recentSecond.getByPlaceholder('Connection name').fill('Unsaved second name')
  await page.evaluate(() => window.layoutFixture.releaseUpdate())
  await row.getByTitle('Edit', { exact: true }).waitFor()
  assert.equal(await recentSecond.getByPlaceholder('Connection name').inputValue(), 'Unsaved second name')
  await recentSecond.getByRole('button', { name: 'Cancel', exact: true }).click()

  const recentFourth = recent.locator(':scope > div').nth(3)
  await recentFourth.getByTitle('Edit', { exact: true }).click()
  await recentFourth.getByPlaceholder('Connection name').fill('Draft while recents change')
  await page.locator('[id$="-connection-4"]').getByRole('button', { name: 'Vertex Argon 5 openai / model-4', exact: true }).click()
  assert.equal(await recentFourth.getByPlaceholder('Connection name').inputValue(), 'Draft while recents change')
  assert.equal(await recent.locator(':scope > div').count(), 4)
  await recentFourth.getByRole('button', { name: 'Cancel', exact: true }).click()
  // Restore the fixture's initial active/recent selection for the six-kind loop.
  await row.getByRole('button', { name: 'Unsaved canonical name openai / model-0', exact: true }).click()

  // Reuse the actual editor in both placements and commit a folder only on Save.
  for (const kind of ['llm', 'imageGen', 'stt', 'tts', 'decision', 'embedding']) {
    await page.evaluate(() => window.layoutFixture.flush())
    await page.goto(`${url}?kind=${kind}`)
    await page.getByText('Recently Used', { exact: true }).waitFor()
    const entry = recent.locator(':scope > div').first()
    const original = (await state())[kind].assignments['connection-0']
    await entry.getByTitle('Edit', { exact: true }).click()
    await chooseFolder(entry, 'Local')
    assert.equal((await state())[kind].assignments['connection-0'], original)
    await entry.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal((await state())[kind].assignments['connection-0'], original)
    await entry.getByTitle('Edit', { exact: true }).click()
    await chooseFolder(entry, 'Hosted')
    if (kind === 'llm') {
      await page.screenshot({ path: join(tmpdir(), 'connection-manager-layout-edit.png'), fullPage: true })
      await page.evaluate(() => { window.layoutFixture.failNextUpdate = true })
      await entry.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForTimeout(100)
      assert.equal((await state())[kind].assignments['connection-0'], original, 'failed profile save cannot move its folder')
    }
    await entry.getByRole('button', { name: 'Save', exact: true }).click()
    await entry.getByTitle('Edit', { exact: true }).waitFor()
    assert.equal((await state())[kind].assignments['connection-0'], 'hosted')
    assert.equal(await recent.locator(':scope > div').count(), 4)
  }
  await page.evaluate(() => window.layoutFixture.flush())
  await page.reload()
  await page.getByText('Recently Used', { exact: true }).waitFor()
  assert.equal((await state()).embedding.assignments['connection-0'], 'hosted')
  assert.equal(await page.evaluate(() => window.layoutFixture.store.getState().activeProfileId), 'connection-0')
  await page.goto(`${url}?kind=llm`)
  await recent.locator(':scope > div').first().getByTitle('Edit', { exact: true }).click()
  await page.getByRole('button', { name: /^Hosted \d+$/ }).click()
  // Keep the anchored menu in view so Playwright does not scroll and dismiss it.
  await row.evaluate(node => node.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(200)
  await row.getByTitle('More actions', { exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: /^Uncategorized \d+$/ }).click()
  await page.locator('[id$="-connection-5"]').getByRole('button', { name: 'Vertex Flash 6 openai / model-5', exact: true }).click()
  assert((await recent.locator(':scope > div').first().innerText()).includes('Vertex Flash 6'),
    'deleting an edited recent connection must release its placement snapshot')
  assert.deepEqual(errors, [])
  console.log('PASS: real managers; compact toolbar and rows; four native recent entries; inline folder CRUD; handle, body, search and folder dragging; transparency; six editors; save/cancel/failure; backend-settings reload')
} catch (error) {
  await page.screenshot({ path: join(tmpdir(), 'connection-manager-layout-failure.png'), fullPage: true })
  console.error('Browser body:', (await page.locator('body').innerText()).slice(0, 3000))
  throw error
} finally {
  await browser.close()
  await server.close()
}
