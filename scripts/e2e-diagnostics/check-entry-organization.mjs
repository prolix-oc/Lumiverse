// Controlled native components inside the real modal shell; no server/login/personal data.
// ENTRY_ORGANIZATION_BROWSERS=chromium,firefox,webkit. Optional PLAYWRIGHT_MODULE path.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
const playwright = process.env.PLAYWRIGHT_MODULE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) : await import('playwright')
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({ absWorkingDir: root, entryPoints: ['frontend/tests/entry-organization.fixture.tsx'], outfile: 'entry-organization.js', bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, plugins: [{ name: 'controlled-world-books', setup(build) { build.onResolve({ filter: /^@\/api\/world-books$/ }, () => ({ path: fileURLToPath(new URL('../../frontend/tests/entry-organization.fixture-api.ts', import.meta.url)) })) } }] })
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
let cases = 0
for (const name of (process.env.ENTRY_ORGANIZATION_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true })
  try {
    for (const width of [1200, 390, 320]) for (const scale of [0.8, 1, 1.5]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(7000)
      const errors = []; page.on('pageerror', error => errors.push(error.message))
      await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>` }))
      await page.goto(`http://fixture.local/?scale=${scale}`)
      await page.getByRole('button', { name: 'Characters 1', exact: true }).click()
      const trigger = page.getByRole('button', { name: 'Move selected…', exact: true })
      try { await trigger.click() } catch (error) { console.error(JSON.stringify({ errors, text: await page.locator('body').innerText() })); throw error }
      const dialog = page.getByRole('dialog', { name: 'Move entries', exact: true })
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${name}/${width}/${scale}: dialog width`)
      assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2, `${name}/${width}/${scale}: dialog centered horizontally`)
      assert.ok(Math.abs(box.y + box.height / 2 - 400) < 2, `${name}/${width}/${scale}: dialog centered vertically`)
      assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true, 'focus enters dialog')
      for (let index = 0; index < 7; index++) await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true, 'focus remains trapped')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.getByTestId('organization-surface').isVisible(), true, 'Escape keeps outer modal open')
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'focus returns to trigger')
      await trigger.click(); await page.getByLabel('Destination folder', { exact: true }).fill('Locations')
      await page.getByLabel('Destination folder', { exact: true }).press('Enter')
      try { await dialog.waitFor({ state: 'detached' }) } catch (error) { console.error(JSON.stringify({ name, width, scale, errors, dialog: await dialog.innerText(), active: await page.evaluate(() => ({ tag: document.activeElement?.tagName, value: document.activeElement?.value })) })); throw error }
      await page.getByRole('button', { name: '‹ Folders', exact: true }).click()
      await page.getByRole('button', { name: 'Locations 1', exact: true }).click()
      await page.getByLabel('Filter entry tags').selectOption('a,b')
      await page.getByLabel('Filter entry tags').selectOption('Villain')
      assert.equal(await page.getByRole('heading', { name: 'Fixture entry', exact: true }).count(), 1, 'all-of tags preserve row')
      await page.getByRole('button', { name: 'Close fixture modal', exact: true }).click()
      await page.getByRole('button', { name: 'Reopen fixture modal', exact: true }).click()
      assert.equal(await page.getByLabel('Entry folder').inputValue(), 'Locations', 'close/reopen preserves move')
      await page.getByLabel('Add entry tag').fill('New tag'); await page.getByLabel('Add entry tag').press('Enter')
      await page.getByRole('button', { name: 'Remove tag New tag', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Remove tag New tag', exact: true }).click()
      await page.getByRole('button', { name: 'Remove folder', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Remove folder', exact: true }).click()
      await page.getByRole('button', { name: '‹ Folders', exact: true }).click()
      await page.getByRole('button', { name: 'Unfiled 1', exact: true }).click()
      assert.equal(await page.getByRole('heading', { name: 'Fixture entry', exact: true }).count(), 1, 'remove folder preserves entry')
      assert.deepEqual(errors, [], 'no browser runtime errors')
      if (process.env.ENTRY_ORGANIZATION_SCREENSHOTS && scale === 1) await page.screenshot({ path: `${process.env.ENTRY_ORGANIZATION_SCREENSHOTS}/${name}-${width}.png`, fullPage: true })
      cases++; await page.close()
    }
  } finally { await browser.close() }
  console.log(`${name}: native organization mouse/keyboard/modal/mobile checks passed`)
}
console.log(`${cases} viewport/scale cases passed; controlled data only`)
