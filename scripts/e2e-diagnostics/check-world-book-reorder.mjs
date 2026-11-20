// Real core modal/list/editor with controlled API/store boundaries; no login or user data.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('../../frontend/tests/world-book-workspace.fixture.tsx', import.meta.url))
const benchmark = process.env.REORDER_BENCHMARK === '1'
const withoutMemo = process.env.REORDER_WITHOUT_MEMO === '1'
const mocked = new Set(['@/store', '@/api/world-books', '@/ws/client', '@/hooks/useWorldBookListLiveSync', '@/hooks/useFolders', '@/hooks/useTokenCounts', 'react-i18next', '@/api/macros', '@/lib/loom/service', '@/components/chat/MessageContent', '@/components/shared/ConfirmationModal', '@/components/shared/PostImportWorldBookModal', '@/components/panels/world-book/WorldBookDiagnosticsModal', '@/components/panels/world-book/WorldBookTokenReportModal'])
const bundle = await build({ absWorkingDir: root, entryPoints: [fixture], outfile: 'workspace.js', bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, plugins: [{ name: 'controlled-workspace', setup(build) { if (withoutMemo) build.onLoad({ filter: /WorldBookEntriesSection\.tsx$/ }, async ({ path }) => { const source = await readFile(path, 'utf8'); const anchor = 'const EntryRowContent = memo(function EntryRowContent('; assert.equal(source.split(anchor).length, 2); return { contents: source.replace(anchor, 'const EntryRowContent = ((component) => component)(function EntryRowContent('), loader: 'tsx' } }); build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture-i18n' })); build.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: 'export default { t: key => key }', loader: 'js' })); build.onResolve({ filter: /.*/ }, args => { if (mocked.has(args.path) || args.path.endsWith('/ImportWorldBookModal')) return { path: fixture } }) } }] })
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const playwright = process.env.PLAYWRIGHT_MODULE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) : await import('playwright')
const theme = `*{box-sizing:border-box;margin:0}html{--app-interactive-safe-top:32px;--lumiverse-bg:#211e2b;--lumiverse-bg-deep:#17151e;--lumiverse-text:#eee;--lumiverse-text-muted:#aaa;--lumiverse-text-dim:#999;--lumiverse-border:#484451;--lumiverse-fill-subtle:#2a2735;--lumiverse-fill-hover:#343040;--lumiverse-primary:#a999db;--lumiverse-font-scale:1;--lumiverse-radius-xl:14px}body{zoom:var(--lumiverse-ui-scale);font:14px Arial;height:calc(100dvh / var(--lumiverse-ui-scale));width:calc(100vw / var(--lumiverse-ui-scale))}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}input,select,textarea{background:var(--lumiverse-bg)}`
// Full-book custom ordering through the real DnD sensors, with controlled data.
let cases = 0
for (const name of (process.env.REORDER_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
 const browser = await playwright[name].launch({ headless: true })
 try { for (const surface of (benchmark ? ['sidebar'] : ['workspace', 'sidebar'])) for (const width of (benchmark ? [1200] : [1200, 390])) for (const scale of (benchmark ? [1] : [1, 1.25])) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + theme + css + '</style></head><body><div id="root"></div><script>' + js + '</script></body></html>' }))
  try {
   console.log(name + '/' + surface + '/' + width + '/' + scale)
   await page.goto('http://fixture.local/?reorderFixture&flatBook&surface=' + surface + '&scale=' + scale)
   await page.locator('[data-entry-id="b5-e0"]').waitFor()
   assert.equal(await page.locator('[data-entry-id]').count(), 50, 'default remains paginated')
   if (width === 390) await page.getByRole('button', { name: 'Entry filters and options', exact: true }).click()
   const size = page.getByRole('combobox', { name: 'perPage', exact: true })
   await size.selectOption('all')
   await page.locator('[data-entry-id="b5-e250"]').waitFor()
   assert.equal(await page.locator('[data-entry-id]').count(), 251)
   assert.equal(await page.getByRole('button', { name: /^dragHandle:/ }).count(), 251)
   assert.equal(await page.locator('[data-world-book-entry-editor]').count(), 0, 'collapsed rows do not mount editors')
   const first = page.getByRole('button', { name: 'dragHandle: Fixture entry 0', exact: true })
   await first.focus()
   const rendersBeforePickup = await page.evaluate(() => Number(document.documentElement.dataset.rowRenders))
   const rowBeforePickup = await page.locator('[data-entry-id="b5-e0"] [data-world-book-entry-row]').boundingBox()
   await first.press('Space')
   await page.waitForFunction(() => document.querySelector('[aria-label="dragHandle: Fixture entry 0"]')?.getAttribute('aria-pressed') === 'true')
   await page.waitForTimeout(200)
   const preview = page.locator('[data-lorebook-drag-preview] [data-world-book-entry-row]')
   assert.equal(await page.locator('[data-entry-id="b5-e0"] > div').evaluate(el => getComputedStyle(el).opacity), '0', 'source row is hidden while the overlay is visible')
   const pickedUp = await preview.boundingBox()
   assert.ok(Math.abs(pickedUp.x - rowBeforePickup.x) < 2 && Math.abs(pickedUp.y - rowBeforePickup.y) < 2, 'preview aligns with the source row inside transformed drawers and scaled modals')
   assert.ok(Math.abs(pickedUp.width - rowBeforePickup.width) < 2 && Math.abs(pickedUp.height - rowBeforePickup.height) < 2, 'preview keeps source dimensions and row presentation: ' + JSON.stringify({ pickedUp, rowBeforePickup }))
   const pickupRenders = await page.evaluate(() => Number(document.documentElement.dataset.rowRenders)) - rendersBeforePickup
   if (!withoutMemo) assert.ok(pickupRenders < 12, 'pickup does not rerender the full book')
   await first.press('ArrowDown')
   await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('b5-e1')))
   await first.press('Space')
   await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.reorder || 'null')?.ordered_ids[0] === 'b5-e1')
   await page.waitForFunction(() => document.querySelector('[data-entry-id]')?.getAttribute('data-entry-id') === 'b5-e1')
   assert.equal(await first.evaluate(el => el === document.activeElement), true, 'keyboard reorder restores handle focus')
   assert.equal(await page.locator('[data-entry-id="b5-e0"] > div').evaluate(el => getComputedStyle(el).opacity), '1', 'source row returns after drop')
   await first.press('Space')
   await page.waitForFunction(() => document.querySelector('[data-lorebook-drag-preview]'))
   await first.press('Escape')
   await page.waitForFunction(() => !document.querySelector('[data-lorebook-drag-preview]'))
   assert.equal(await page.locator('[data-entry-id="b5-e0"] > div').evaluate(el => getComputedStyle(el).opacity), '1', 'source row returns after cancellation')
   const from = page.getByRole('button', { name: 'dragHandle: Fixture entry 201', exact: true })
   const to = page.getByRole('button', { name: 'dragHandle: Fixture entry 199', exact: true })
   await from.scrollIntoViewIfNeeded()
   await to.scrollIntoViewIfNeeded()
   const a = await from.boundingBox(), b = await to.boundingBox()
   const sourceRow = await page.locator('[data-entry-id="b5-e201"] [data-world-book-entry-row]').boundingBox()
   const rendersBeforePointer = await page.evaluate(() => Number(document.documentElement.dataset.rowRenders))
   await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
   await page.mouse.down()
   await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2, { steps: 3 })
   await page.waitForTimeout(100)
   assert.equal(await from.getAttribute('aria-pressed'), 'true', 'pointer sensor activates')
   await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
   await page.waitForTimeout(100)
   assert.equal(await page.locator('[data-entry-id="b5-e201"] > div').evaluate(el => getComputedStyle(el).opacity), '0', 'pointer drag does not leave a second visible row')
   const movedPreview = await preview.boundingBox()
   assert.ok(Math.abs(movedPreview.y - (sourceRow.y + b.y - a.y)) < 3, 'preview follows the pointer after scrolling deep into the book')
   const pointerRenders = await page.evaluate(() => Number(document.documentElement.dataset.rowRenders)) - rendersBeforePointer
   if (!withoutMemo) assert.ok(pointerRenders < 12, 'pointer movement does not rerender all entry content')
   console.log(JSON.stringify({ browser: name, surface, width, scale, withoutMemo, pickupRenders, pointerRenders }))
   await page.mouse.up()
   await page.waitForFunction(() => { const ids = JSON.parse(document.documentElement.dataset.reorder || 'null')?.ordered_ids; return ids && ids.indexOf('b5-e201') < ids.indexOf('b5-e200') })
   const payload = await page.evaluate(() => JSON.parse(document.documentElement.dataset.reorder))
   assert.equal(payload.ordered_ids.length, 251, 'reorder includes the entire book beyond old page limits')
   assert.equal(Object.keys(payload.expected_revisions).length, 251)
   assert.equal(new Set(payload.ordered_ids).size, 251)
   await size.selectOption('50')
   await page.waitForFunction(() => document.querySelectorAll('[data-entry-id]').length === 50)
   assert.equal(await page.getByRole('button', { name: /^dragHandle:/ }).count(), 0, 'partial books cannot send reorder payloads')
   await size.selectOption('all')
   await page.locator('[data-entry-id="b5-e250"]').waitFor()
   await page.reload()
   await page.locator('[data-entry-id="b5-e250"]').waitFor()
   assert.equal(await page.locator('[data-entry-id]').count(), 251, 'All entries preference survives remount')
   if (width === 390) await page.getByRole('button', { name: 'Entry filters and options', exact: true }).click()
   assert.equal(await size.inputValue(), 'all')
   await page.locator('input[type="search"]:visible').fill('Fixture entry 250')
   await page.waitForFunction(() => document.querySelectorAll('[data-entry-id]').length === 1)
   assert.equal(await page.getByRole('button', { name: /^dragHandle:/ }).count(), 0, 'search disables custom reorder')
   await page.locator('input[type="search"]:visible').press('Escape')
   await page.waitForFunction(() => document.querySelectorAll('[data-entry-id]').length === 251)
   assert.deepEqual(errors, [])
   cases++
  } finally { await page.close() }
 } } finally { await browser.close() }
 console.log(name + ': full-book pointer and keyboard reordering passed on desktop/mobile workspace/sidebar')
}
console.log(cases + ' controlled reorder cases passed')
