// Real guide reader and modal shell with controlled documentation responses.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'

const playwright = process.env.PLAYWRIGHT_MODULE
  ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  : await import('playwright')
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const bundle = await build({
  absWorkingDir: frontend,
  outfile: 'guide-reader.js',
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  stdin: {
    resolveDir: frontend, loader: 'tsx', contents: `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { GuideReaderHost } from './src/components/shared/GuideReaderHost'
      import { ModalShell } from './src/components/shared/ModalShell'
      import { openGuide } from './src/lib/guides/reader-session'
      import appStyles from './src/App.module.css'
      import landingStyles from './src/components/landing/LandingPage.module.css'
      import './src/theme/variables.css'
      import './src/theme/reset.css'
      function Fixture() {
        const [workspace, setWorkspace] = useState(false)
        const [overlay, setOverlay] = useState(false)
        return <>
          <main className={appStyles.app} aria-label="Workspace">
            <div className={landingStyles.container}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <span className={landingStyles.accountName}>Account label</span>
                <button onClick={(event) => openGuide({ kind: 'builtin', path: 'index.md' }, 'Lumiverse Guides', event.currentTarget)}>Open guides</button>
                <button onClick={() => setWorkspace(!workspace)}>Change workspace</button>
                <button onClick={() => setOverlay(true)}>Open overlay</button>
              </div>
              {workspace && <h1>Another workspace</h1>}
            </div>
          </main>
          <ModalShell isOpen={overlay} onClose={() => setOverlay(false)} fullscreen zIndex={11050} data-component="fixture-overlay">
            <section role="dialog" aria-label="Underlying dialog">
              <input aria-label="Overlay field" defaultValue="Unsaved setting" />
            </section>
          </ModalShell>
          <GuideReaderHost />
        </>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    `,
  },
})
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css')).text
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text
const records = [
  { path: 'index.md', title: 'Lumiverse Guides' },
  { path: 'start/setup.md', title: 'Connection Setup', searchText: 'How to connect a provider.' },
  { path: 'examples.md', title: 'Examples', searchText: 'Connection setup examples.' },
]
const documents = new Map([
  ['index.md', '# Guides home\n\n[Read setup](start/setup.md#details)'],
  ['start/setup.md', '# Set up your connection\n\n' + 'Before you begin.\n\n'.repeat(35) + '## Details\n\n' + 'More information.\n\n'.repeat(24)],
])

async function drag(page, handle, dx, dy) {
  const { x, y, width, height } = await handle.boundingBox()
  await page.mouse.move(x + width / 2, y + height / 2)
  await page.mouse.down()
  await page.mouse.move(x + width / 2 + dx, y + height / 2 + dy, { steps: 4 })
  await page.mouse.up()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function assertSidebar(reader, heading) {
  const navigation = await reader.getByRole('navigation').boundingBox()
  const article = await heading.boundingBox()
  assert.ok(navigation.x + navigation.width <= article.x + 1, 'navigation sits beside the article')
}

for (const engine of (process.env.GUIDE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true })
  try {
    for (const width of [1280, 783, 390]) {
      for (const scale of [1, 1.25]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 600 })
        try {
          const errors = []
          page.on('pageerror', (error) => errors.push(error.message))
          const safeTop = width < 600 ? 47 : 0
          await page.route('http://guide.test/**', async (route) => {
            const path = new URL(route.request().url()).pathname
            if (path.endsWith('/catalog')) return route.fulfill({ json: records })
            if (path.startsWith('/api/v1/docs/file/')) {
              const markdown = documents.get(Buffer.from(path.split('/').at(-1), 'base64url').toString('utf8'))
              return route.fulfill({ status: markdown ? 200 : 404, body: markdown ?? '' })
            }
            return route.fulfill({
              contentType: 'text/html',
              body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>'
                + css + ':root{--lumiverse-ui-scale:' + scale + ';--app-interactive-safe-top:' + safeTop
                + 'px}</style></head><body style="zoom:' + scale + '"><div id="root"></div><script>'
                + js + '</script></body></html>',
            })
          })
          await page.goto('http://guide.test/')
          const trigger = page.getByRole('button', { name: 'Open guides' })
          const accountLabel = page.getByText('Account label')
          if (width === 783) assert.equal(await accountLabel.isVisible(), true)
          await trigger.click()
          const dialog = page.getByRole('dialog', { name: 'Lumiverse Guides' })
          const heading = page.getByRole('heading', { name: 'Set up your connection' })
          const modalButton = dialog.getByRole('button', { name: 'Modal view' })
          await page.keyboard.press('Tab')
          assert.equal(await modalButton.evaluate((element) => element === document.activeElement), true)
          await page.keyboard.press('Shift+Tab')
          assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
          await dialog.getByRole('link', { name: 'Read setup' }).click()
          await heading.waitFor({ state: 'attached' })
          assert.ok(await dialog.locator('#details').evaluate((el) => el.parentElement.parentElement.scrollTop > 0))
          const search = dialog.getByRole('searchbox')
          await search.fill('connection setup')
          const results = dialog.getByRole('navigation')
          assert.match(await results.getByRole('button').first().innerText(), /Connection Setup/)
          await assertSidebar(dialog, heading)
          if (process.env.GUIDE_SCREENSHOTS && engine === 'chromium' && scale === 1) {
            await page.screenshot({ path: join(process.env.GUIDE_SCREENSHOTS, 'guide-search-' + width + '.png') })
          }
          await dialog.getByRole('button', { name: 'Clear guide search' }).click()
          assert.equal(await search.inputValue(), '')
          assert.equal(await search.evaluate((element) => element === document.activeElement), true)
          await search.fill('connection setup')
          await search.press('Escape')
          assert.equal(await search.inputValue(), '')
          await dialog.getByRole('button', { name: 'Guide navigation' }).click()
          assert.equal(await results.isVisible(), false)
          await dialog.getByRole('button', { name: 'Half-dock view' }).click()
          const reader = page.getByRole('region', { name: 'Lumiverse Guides' })
          await reader.waitFor()
          const bounds = await reader.boundingBox()
          assert.ok(bounds.y >= safeTop - 1 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1)
          if (width >= 600) {
            assert.ok(bounds.x < 4 && Math.abs(bounds.width - width / 2) < 4)
            await reader.getByRole('button', { name: 'Move guide dock to the right' }).click()
            assert.ok((await reader.boundingBox()).x >= width / 2 - 1)
            await reader.getByRole('button', { name: 'Move guide dock to the left' }).click()
          } else {
            assert.ok(bounds.y > 844 / 2 - 1)
          }
          const workspace = page.getByRole('main', { name: 'Workspace' })
          const dockHandle = page.getByRole('separator', { name: 'Resize guide dock' })
          await drag(page, dockHandle, width >= 600 ? 40 : 0, width >= 600 ? 0 : -40)
          await page.waitForFunction((compact) => {
            const app = document.querySelector('main[aria-label="Workspace"]').getBoundingClientRect()
            const dock = document.querySelector('[data-component="guide-viewer"]').getBoundingClientRect()
            return Math.abs(compact ? app.bottom - dock.top : app.left - dock.right) < 2
          }, width < 600)
          const resizedDock = await reader.boundingBox()
          const app = await workspace.boundingBox()
          if (width === 783) assert.equal(await accountLabel.isVisible(), false)
          if (width >= 600) {
            assert.ok(resizedDock.width > bounds.width + 25)
            assert.ok(Math.abs(app.x - (resizedDock.x + resizedDock.width)) < 2)
          } else {
            assert.ok(resizedDock.height > bounds.height + 25)
            assert.ok(Math.abs(app.y + app.height - resizedDock.y) < 2)
          }
          await dockHandle.press(width >= 600 ? 'ArrowLeft' : 'ArrowDown')
          const keyboardDock = await reader.boundingBox()
          assert.ok(width >= 600 ? keyboardDock.width < resizedDock.width : keyboardDock.height < resizedDock.height)
          await reader.getByRole('button', { name: 'Guide navigation' }).click()
          await assertSidebar(reader, heading)
          await page.getByRole('button', { name: 'Change workspace' }).click()
          assert.equal(await page.getByRole('heading', { name: 'Another workspace' }).count(), 1)
          const originalSize = await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
          await reader.getByRole('button', { name: 'Zoom in' }).click()
          assert.ok(await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) > originalSize)
          await reader.getByRole('button', { name: 'Widget view' }).click()
          assert.ok(Math.abs((await workspace.boundingBox()).width - width) < 2)
          assert.ok(Math.abs((await workspace.boundingBox()).height - 844) < 2)
          if (width === 783) assert.equal(await accountLabel.isVisible(), true)
          await assertSidebar(reader, heading)
          const moveHandle = page.getByTitle('Drag to move or pinch to resize')
          const widgetStart = await reader.boundingBox()
          await drag(page, moveHandle, width >= 600 ? -50 : 0, -50)
          const movedWidget = await reader.boundingBox()
          assert.ok(movedWidget.y < widgetStart.y - 30)
          const resizeHandle = page.getByRole('group', { name: 'Resize guide widget with arrow keys' })
          await drag(page, resizeHandle, width >= 600 ? 25 : 0, 34)
          await page.waitForFunction((height) =>
            document.querySelector('[data-component="guide-viewer"]').getBoundingClientRect().height > height + 18,
          movedWidget.height)
          const resizedWidget = await reader.boundingBox()
          assert.ok(resizedWidget.height > movedWidget.height + 18)
          if (width >= 600) assert.ok(resizedWidget.width > movedWidget.width + 12)
          if (engine === 'chromium' && width < 600) {
            const client = await page.context().newCDPSession(page)
            const { x, y, width: gripWidth, height } = await moveHandle.boundingBox()
            const center = x + gripWidth / 2
            const touch = (offset, id) => ({ id, x: center + offset, y: y + height / 2 })
            const dispatch = (type, touchPoints) => client.send('Input.dispatchTouchEvent', { type, touchPoints })
            await dispatch('touchStart', [touch(-35, 1), touch(35, 2)])
            await dispatch('touchMove', [touch(-24, 1), touch(24, 2)])
            await dispatch('touchEnd', [])
            assert.ok((await reader.boundingBox()).height < resizedWidget.height - 20)
            await client.detach()
          }
          const widgetBeforeMinimize = await reader.boundingBox()
          await reader.getByRole('button', { name: 'Minimize guide widget' }).click()
          assert.equal(await reader.count(), 0)
          await page.getByRole('button', { name: 'Expand guide reader: Lumiverse Guides' }).click()
          await reader.getByRole('button', { name: /Reset reading zoom, currently 110%/ }).waitFor()
          assert.deepEqual(await reader.boundingBox(), widgetBeforeMinimize)
          const tabs = reader.getByRole('group', { name: 'Open guide pages' })
          await tabs.getByRole('button', { name: 'Lumiverse Guides', exact: true }).click()
          await reader.getByRole('heading', { name: 'Guides home' }).waitFor()
          await tabs.getByRole('button', { name: 'Connection Setup', exact: true }).click()
          await heading.waitFor({ state: 'attached' })
          if (process.env.GUIDE_SCREENSHOTS && engine === 'chromium' && scale === 1) {
            await page.screenshot({ path: join(process.env.GUIDE_SCREENSHOTS, 'guide-widget-' + width + '.png') })
          }
          await reader.getByRole('button', { name: 'Close guide reader' }).click()
          assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)

          await page.getByRole('button', { name: 'Open overlay' }).click()
          const underlying = page.getByRole('dialog', { name: 'Underlying dialog' })
          const field = underlying.getByRole('textbox')
          await field.fill('Unsaved edit')
          await field.press('F1')
          // The previous session was a widget. It must remain interactive above the newer modal.
          await reader.getByRole('button', { name: 'Modal view' }).click()
          await dialog.getByRole('button', { name: 'Half-dock view' }).click()
          const overlay = await page.locator('[data-modal="fixture-overlay"]').boundingBox()
          const guideDock = await reader.boundingBox()
          if (width < 600) assert.ok(overlay.y + overlay.height <= guideDock.y + 1)
          else assert.ok(overlay.x >= guideDock.x + guideDock.width - 1)
          await field.fill('Edited while docked')
          await reader.getByRole('button', { name: 'Widget view' }).click()
          await reader.getByRole('button', { name: 'Minimize guide widget' }).click()
          await page.getByRole('button', { name: 'Expand guide reader: Lumiverse Guides' }).press('F1')
          await reader.getByRole('button', { name: 'Modal view' }).click()
          await dialog.press('Escape')
          assert.equal(await field.inputValue(), 'Edited while docked')
          assert.equal(await field.evaluate((element) => element === document.activeElement), true)
          assert.equal(await dialog.count(), 0)
          assert.deepEqual(errors, [])
          console.log(engine + ' · ' + width + 'px · ' + scale + '× passed')
        } finally {
          await page.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}
