// No backend needed: node scripts/e2e-diagnostics/check-dnd-ui-scale.mjs
// Optional browser arguments: chromium webkit. UI_SCALE_VALUES=0.8 narrows the
// scale sweep; --inputs-only runs just the automatic scrolling and touch cases.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
  entryPoints: ['frontend/tests/dnd-ui-scale.fixture.tsx'],
  outfile: 'dnd-ui-scale.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: expected ${expected}, got ${actual}`)
const rect = (page, selector) => page.locator(selector).evaluate(el => el.getBoundingClientRect().toJSON())
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const sizes = page => page.locator('#rows > div, #outer-scroll, #inner-scroll, #rows').evaluateAll(els => els.map(el => ({ id: el.id, ...el.getBoundingClientRect().toJSON() })))
const dimensionsMatch = (current, originals, label) => {
  for (const box of current) {
    const original = originals.find(original => original.id === box.id)
    near(box.width, original.width, `${label} ${box.id} width`)
    near(box.height, original.height, `${label} ${box.id} height`)
  }
}
const scales = process.env.UI_SCALE_VALUES?.split(',').map(Number) ?? Array.from({ length: 21 }, (_, index) => (50 + index * 5) / 100).concat(1)
const inputsOnly = process.argv.includes('--inputs-only')
const browsers = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const loadFixture = async (browser, mode, mobile = false) => {
  const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1000, height: 900 }, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  page.setDefaultTimeout(10_000)
  await page.setContent(`<html ${mode === 'linux' ? 'data-tauri-desktop data-platform="linux"' : ''}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({ content: js })
  await page.waitForFunction(() => !!window.dndFixture)
  return page
}

let cases = 0
for (const name of browsers.length ? browsers : (process.env.UI_SCALE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true, timeout: 15_000 })
  try {
    for (const mode of inputsOnly ? [] : ['web', 'linux']) {
      const page = await loadFixture(browser, mode)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      for (const scale of scales) {
        const label = `${name}/${mode}/${scale}`
        await page.evaluate(scale => {
          window.dndFixture.setScale(scale)
          window.dndFixture.reset()
          for (const id of ['outer-scroll', 'inner-scroll']) document.getElementById(id).scrollTo(0, 0)
        }, scale)
        await settle(page)
        const originals = await sizes(page)
        const row = originals.find(row => row.id === 'row-1')
        const handle = await rect(page, '#row-1 button')
        const x = handle.left + handle.width / 2, y = handle.top + handle.height / 2
        const check = async (dx, dy, phase) => {
          const dragged = await rect(page, '#row-1')
          near(dragged.left - row.left, dx, `${label} ${phase} x`)
          near(dragged.top - row.top, dy, `${label} ${phase} y`)
          dimensionsMatch(await sizes(page), originals, `${label} ${phase}`)
        }
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 12, y + 10, { steps: 5 })
        await settle(page)
        await check(12, 10, 'activation')
        await page.mouse.move(x + 20, y + 70, { steps: 5 })
        await settle(page)
        await check(20, 70, 'over taller row')
        await page.locator('#inner-scroll').evaluate(el => { el.scrollTop += 32 })
        await settle(page)
        await check(20, 70, 'inner scroll, stationary pointer')
        await page.locator('#outer-scroll').evaluate(el => { el.scrollTop += 24; el.scrollLeft += 16 })
        await settle(page)
        await check(20, 70, 'outer scroll, stationary pointer')
        // Sample every frame of the actual reorder/drop animation, including
        // siblings that useSortable no longer marks as dragging.
        await page.evaluate(() => {
          window.dropFrames = []
          const until = performance.now() + 350
          const sample = () => {
            window.dropFrames.push(Array.from(document.querySelectorAll('#rows > div, #outer-scroll, #inner-scroll, #rows'), el => ({ id: el.id, ...el.getBoundingClientRect().toJSON() })))
            if (performance.now() < until) requestAnimationFrame(sample)
          }
          sample()
        })
        await page.mouse.up()
        await page.waitForTimeout(400)
        for (const frame of await page.evaluate(() => window.dropFrames)) dimensionsMatch(frame, originals, `${label} drop`)

        // Rectangle sorting strategies can supply size changes for siblings
        // even while dragging; the shared helper must preserve those too.
        await page.evaluate(() => {
          window.dndFixture.reset()
          window.dndFixture.setRectStrategy(true)
          for (const id of ['outer-scroll', 'inner-scroll']) document.getElementById(id).scrollTo(0, 0)
        })
        await page.waitForTimeout(250)
        const rectOriginals = await sizes(page)
        const rectHandle = await rect(page, '#row-1 button')
        await page.mouse.move(rectHandle.left + rectHandle.width / 2, rectHandle.top + rectHandle.height / 2)
        await page.mouse.down()
        await page.mouse.move(rectHandle.left + rectHandle.width / 2, rectHandle.top + rectHandle.height / 2 + 70, { steps: 5 })
        await page.waitForTimeout(250)
        dimensionsMatch(await sizes(page), rectOriginals, `${label} rectangle sorting`)
        await page.keyboard.press('Escape')
        await page.mouse.up()
        await page.evaluate(() => window.dndFixture.setRectStrategy(false))

        // Keyboard sorting must still move exactly one row and commit order.
        await page.waitForTimeout(250)
        await page.locator('#row-1 button').focus()
        await page.keyboard.press('Space')
        await page.keyboard.press('ArrowDown')
        await page.waitForTimeout(250)
        dimensionsMatch(await sizes(page), originals, `${label} keyboard sorting`)
        await page.keyboard.press('Space')
        await page.waitForTimeout(250)
        assert.deepEqual(await page.locator('#rows > div').evaluateAll(els => els.slice(0, 3).map(el => el.id)), ['row-0', 'row-2', 'row-1'], `${label} keyboard reorder`)
        assert.deepEqual(errors, [], `${label} browser errors`)
        cases++
      }
      await page.close()
      console.log(`${name}/${mode}: passed`)
    }

    for (const mode of ['web', 'linux']) {
      const page = await loadFixture(browser, mode)
      for (const scale of [0.5, 0.8, 1, 1.5]) {
        const label = `${name}/${mode}/${scale} auto-scroll`
        await page.evaluate(scale => {
          window.dndFixture.setScale(scale)
          window.dndFixture.setAutoScroll(true)
        }, scale)
        await settle(page)
        await page.evaluate(() => {
          document.getElementById('inner-scroll').scrollTop = 40
          document.getElementById('outer-scroll').scrollTop = 24
        })
        await settle(page)
        const originals = await sizes(page)
        const row = await rect(page, '#row-1')
        const handle = await rect(page, '#row-1 button')
        const inner = await rect(page, '#inner-scroll')
        const x = handle.left + handle.width / 2, y = handle.top + handle.height / 2
        const targetY = inner.bottom - 12 * scale
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[id^="row-"]')?.id, { x, y })
        assert.equal(hit, 'row-1', `${label} handle is visible`)
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x, targetY, { steps: 5 })
        await page.waitForFunction(() => document.getElementById('inner-scroll').scrollTop > 70).catch(async error => {
          throw new Error(`${label}: ${JSON.stringify(await page.evaluate(() => ({
            inner: document.getElementById('inner-scroll').scrollTop,
            outer: document.getElementById('outer-scroll').scrollTop,
            dragging: document.querySelector('#row-1 button').getAttribute('aria-pressed'),
            transform: document.getElementById('row-1').style.transform,
          })))}`, { cause: error })
        })
        await page.waitForTimeout(100)
        // Stop the scrolling interval before measuring, so a scroll tick cannot
        // land between the browser geometry read and React's scroll update.
        // No pointer event is sent: compensation must update on scroll alone.
        await page.evaluate(() => window.dndFixture.setAutoScroll(false))
        await settle(page)
        const dragged = await rect(page, '#row-1')
        near(dragged.left, row.left, `${label} x`)
        near(dragged.top - row.top, targetY - y, `${label} stationary pointer y`)
        dimensionsMatch(await sizes(page), originals, label)
        await page.keyboard.press('Escape')
        await page.mouse.up()
        await page.waitForTimeout(250)
        cases++
      }
      await page.close()
      console.log(`${name}/${mode}: auto-scroll passed`)
    }

    // Chromium exposes native touch injection through CDP, which exercises the
    // configured TouchSensor on a mobile viewport rather than synthetic mouse events.
    if (name === 'chromium') {
      const page = await loadFixture(browser, 'web', true)
      const cdp = await page.context().newCDPSession(page)
      for (const scale of [0.5, 0.8, 1, 1.5]) {
        const label = `${name}/mobile/${scale} touch`
        await page.evaluate(scale => {
          window.dndFixture.setScale(scale)
          window.dndFixture.reset()
          for (const id of ['outer-scroll', 'inner-scroll']) document.getElementById(id).scrollTo(0, 0)
        }, scale)
        await settle(page)
        const originals = await sizes(page)
        const row = await rect(page, '#row-1')
        const handle = await rect(page, '#row-1 button')
        const x = handle.left + handle.width / 2, y = handle.top + handle.height / 2
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        await page.waitForTimeout(220)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 15, y: y + 60 }] })
        await settle(page)
        const dragged = await rect(page, '#row-1')
        near(dragged.left - row.left, 15, `${label} x`)
        near(dragged.top - row.top, 60, `${label} y`)
        await page.locator('#outer-scroll').evaluate(el => { el.scrollTop += 24; el.scrollLeft += 16 })
        await settle(page)
        const scrolled = await rect(page, '#row-1')
        near(scrolled.left - row.left, 15, `${label} scrolled x`)
        near(scrolled.top - row.top, 60, `${label} scrolled y`)
        dimensionsMatch(await sizes(page), originals, label)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(250)
        cases++
      }
      await page.close()
      console.log(`${name}/mobile: touch passed`)
    }
  } finally {
    await browser.close()
  }
}
console.log(`${cases} drag UI scale browser cases passed`)
