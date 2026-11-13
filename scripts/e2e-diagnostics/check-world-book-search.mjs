// Real core modal/list/editor with controlled API/store boundaries; no login or user data.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('../../frontend/tests/world-book-workspace.fixture.tsx', import.meta.url))
const mocked = new Set(['@/store', '@/api/world-books', '@/ws/client', '@/hooks/useWorldBookListLiveSync', '@/hooks/useFolders', '@/hooks/useTokenCounts', 'react-i18next', '@/api/macros', '@/lib/loom/service', '@/components/chat/MessageContent', '@/components/shared/ConfirmationModal', '@/components/shared/PostImportWorldBookModal', '@/components/panels/world-book/WorldBookDiagnosticsModal', '@/components/panels/world-book/WorldBookTokenReportModal'])
const bundle = await build({ absWorkingDir: root, entryPoints: [fixture], outfile: 'workspace.js', bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, plugins: [{ name: 'controlled-workspace', setup(build) { build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture-i18n' })); build.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: 'export default { t: key => key }', loader: 'js' })); build.onResolve({ filter: /.*/ }, args => { if (mocked.has(args.path) || args.path.endsWith('/ImportWorldBookModal')) return { path: fixture } }) } }] })
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const playwright = process.env.PLAYWRIGHT_MODULE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) : await import('playwright')
const theme = `*{box-sizing:border-box;margin:0}html{--lumiverse-bg:#211e2b;--lumiverse-bg-deep:#17151e;--lumiverse-text:#eee;--lumiverse-text-muted:#aaa;--lumiverse-text-dim:#999;--lumiverse-border:#484451;--lumiverse-fill-subtle:#2a2735;--lumiverse-fill-hover:#343040;--lumiverse-primary:#a999db;--lumiverse-font-scale:1;--lumiverse-radius-xl:14px}body{zoom:var(--lumiverse-ui-scale);font:14px Arial;height:calc(100dvh / var(--lumiverse-ui-scale));width:calc(100vw / var(--lumiverse-ui-scale))}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}input,select,textarea{background:var(--lumiverse-bg)}`
// Keep search coverage separate from the fullscreen safe-area diagnostics.
let cases = 0
for (const name of (process.env.SEARCH_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
 const browser = await playwright[name].launch({ headless: true })
 try { for (const surface of ['workspace', 'sidebar']) for (const width of [1200, 412]) for (const scale of [1, 1.25]) {
  const page = await browser.newPage({ viewport: { width, height: 915 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${theme}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>` }))
  try {
   await page.goto(`http://fixture.local/?searchFixture&surface=${surface}&scale=${scale}`)
   if (surface === 'workspace') {
    await page.locator('[data-entry-id="b1-e0"]').waitFor()
    if (width === 412) await page.getByRole('button', { name: 'Books', exact: true }).click()
    await page.getByRole('button', { name: /Fixture book 137/ }).click()
   }
   const folders = page.getByRole('navigation', { name: 'Entry folders', exact: true }).filter({ visible: true })
   await folders.waitFor()
   const folderRows = folders.getByRole('button')
   const geometry = await folderRows.evaluateAll(rows => rows.map(row => {
    const style = getComputedStyle(row)
    return { display: style.display, minHeight: parseFloat(style.minHeight), border: style.borderTopStyle, radius: parseFloat(style.borderRadius), icons: row.querySelectorAll('svg[aria-hidden="true"]').length, overflow: row.scrollWidth > row.clientWidth + 1 }
   }))
   assert.ok(geometry.every(row => row.display === 'grid' && row.minHeight === 48 && row.border === 'solid' && row.radius === 10 && row.icons === 2 && !row.overflow), 'folder cards keep icons, borders and touch targets without overflow')
   await folderRows.first().press('Tab')
   assert.equal(await folderRows.nth(1).evaluate(el => el === document.activeElement), true, 'folder navigation follows native keyboard order')
   assert.equal(await folderRows.nth(1).evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'keyboard focus remains visible')
   if (process.env.FOLDER_SCREENSHOT && name === 'chromium' && width === 412 && scale === 1 && surface === 'workspace') await page.screenshot({ path: process.env.FOLDER_SCREENSHOT })
   await folderRows.nth(2).press('Enter')
   await page.locator('[data-entry-id="b5-e1"]').waitFor()
   await page.getByRole('button', { name: /Folders$/, exact: false }).click()
   await folders.waitFor()
   await page.getByRole('button', { name: 'All entries 137', exact: true }).click()
   await page.locator('[data-entry-id="b5-e0"]').waitFor()
   assert.equal(await page.locator('[data-entry-id]:visible').count(), 50)
   const input = page.locator('input[type="search"]:visible')
   await input.fill('dragon')
   await page.waitForFunction(() => document.querySelector('[data-entry-id^="b5-"]')?.getAttribute('data-entry-id') === 'b5-e136')
   assert.equal(await page.locator('[data-entry-id]:visible').count(), 50, 'ranked results remain paginated')
   assert.ok(await page.locator('[data-entry-id="b5-e136"] mark').count(), 'title match is highlighted')
   await page.getByRole('button', { name: 'nextPage', exact: true }).click()
   assert.equal(await page.locator('[data-entry-id="b5-e136"]').count(), 0, 'later page follows relevance order')
   await input.fill('dragn')
   await page.waitForFunction(() => document.querySelectorAll('[data-entry-id^="b5-"]').length === 1)
   assert.equal(await page.locator('[data-entry-id^="b5-"]').getAttribute('data-entry-id'), 'b5-e136', 'typo search retains the closest title')
   await input.press('Escape')
   await page.locator('[data-entry-id="b5-e0"]').waitFor()
   assert.equal(await input.inputValue(), '')
   assert.equal(await input.evaluate(el => el === document.activeElement), true, 'clearing preserves search focus')
   await input.fill('dragon')
   await page.waitForFunction(() => document.querySelector('[data-entry-id^="b5-"]')?.getAttribute('data-entry-id') === 'b5-e136')
   await page.locator('[data-entry-id="b5-e136"]').getByRole('button', { name: surface === 'workspace' ? 'Open entry editor' : 'expandEditor', exact: true }).click()
   if (surface === 'workspace') {
    await page.getByRole('button', { name: /Entries$/, exact: false }).click()
    assert.equal(await input.inputValue(), 'dragon', 'returning from detail preserves query')
   } else {
    await page.locator('[data-entry-id="b5-e136"]').getByRole('button', { name: 'collapseEditor', exact: true }).click()
    assert.equal(await input.inputValue(), 'dragon', 'closing inline editor preserves query')
   }
   await input.fill('no-such-match')
   await page.waitForFunction(() => document.querySelectorAll('[data-entry-id^="b5-"]:not([data-entry-id="b5-e136"])').length === 0)
   assert.equal(await page.locator('[data-entry-id^="b5-"]').count(), 0, 'no matches leaves the navigator empty after closing the editor')
   await input.press('Escape')
   await page.locator('[data-entry-id="b5-e0"]').waitFor()
   assert.deepEqual(errors, [])
   cases++
  } finally { await page.close() }
 } } finally { await browser.close() }
 console.log(`${name}: ranked entry search passed on desktop/mobile workspace/sidebar`)
}
console.log(`${cases} controlled search cases passed`)
