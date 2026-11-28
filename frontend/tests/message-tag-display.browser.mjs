import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', logLevel: 'warn', plugins: [react()],
  optimizeDeps: { entries: ['tests/message-tag-display.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}/src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.endsWith('/display-preprocess')) {
      let body = ''
      for await (const chunk of req) body += chunk
      res.end(JSON.stringify({ items: JSON.parse(body).items.map(item => ({ content: item.rawContent, incrementalRawAppendSafe: true })) }))
      return
    }
    res.end(JSON.stringify({ data: [] }))
    return
  }
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/tests/message-tag-display.fixture.tsx"></script>'))
})
await server.listen()
try {
  for (const name of (process.env.SLOT_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [1280, 390, 320]) {
        for (const cards of ['minimal', 'bubble']) {
          const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 400, reducedMotion: 'reduce' })
          try {
            const errors = []
            page.on('pageerror', error => errors.push(error.message))
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?cards=${cards}`)
            const slots = page.locator('[data-spindle-tag-display="slot-fixture"]')
            await slots.first().getByRole('button').waitFor({ timeout: 60000 })
            assert.equal(await slots.count(), 2)
            assert.equal(await page.locator('strong').first().textContent(), 'After first')
            assert.equal(await page.locator('em').first().textContent(), 'After second')
            assert.equal(await page.getByLabel('Read-only preview').locator('[data-spindle-tag-display]').count(), 0)
            assert(!(await page.locator('main > :first-child').innerText()).includes('private first packet'))
            await page.evaluate(() => {
              window.slotNodes = [...document.querySelectorAll('[data-spindle-tag-display]')]
              window.ordinaryImage = document.querySelector('img[alt="ordinary"]')
            })
            const size = await slots.first().boundingBox()
            assert(size.width > 0 && Math.abs(size.width / size.height - 4 / 3) < 0.02, 'reserves the requested aspect ratio')
            await slots.first().getByRole('button').click()
            for (let index = 1; index <= 3; index++) {
              await page.evaluate(index => window.tagDisplayFixture.update(`\n\nStreamed prose ${index}`), index)
              await page.getByText(`Streamed prose ${index}`, { exact: true }).waitFor()
              assert(await page.evaluate(() => [...document.querySelectorAll('[data-spindle-tag-display]')].every((node, index) => node === window.slotNodes[index])))
              assert(await page.evaluate(() => document.querySelector('img[alt="ordinary"]') === window.ordinaryImage))
              assert.equal(await slots.first().getByRole('button').textContent(), 'Clicked')
            }
            assert.equal(await page.evaluate(() => window.tagDisplayFixture.deliveries.length), 2, 'stream frames retain delivery deduplication')
            await page.evaluate(() => window.tagDisplayFixture.finish())
            await page.waitForFunction(() => [...document.querySelectorAll('[data-spindle-tag-display]')].every(node => node.dataset.spindleTagStreaming === 'false'))
            assert(await page.evaluate(() => document.querySelector('[data-spindle-tag-display]') === window.slotNodes[0]))
            await page.evaluate(() => window.tagDisplayFixture.swipe(1))
            await page.waitForFunction(() => document.querySelector('[data-spindle-tag-display]')?.dataset.spindleTagSwipe === '1')
            assert(await page.evaluate(() => document.querySelector('[data-spindle-tag-display]') !== window.slotNodes[0]))
            assert.equal(await slots.first().getByRole('button').textContent(), 'Interact')
            await page.evaluate(() => {
              window.slotNodes = [...document.querySelectorAll('[data-spindle-tag-display]')]
              window.tagDisplayFixture.store.setState({ activeChatId: 'another-chat' })
            })
            await page.waitForFunction(() => document.querySelector('[data-spindle-tag-display]')?.dataset.spindleTagChat === 'another-chat')
            assert(await page.evaluate(() => document.querySelector('[data-spindle-tag-display]') !== window.slotNodes[0]))
            await page.evaluate(() => window.tagDisplayFixture.remount())
            await slots.first().getByRole('button').waitFor()
            await page.evaluate(() => window.tagDisplayFixture.dispose())
            await page.waitForFunction(() => !document.querySelector('[data-spindle-tag-display]'))
            assert.deepEqual(errors, [])
            console.log(`${name} ${width}px ${cards}: Markdown, aspect ratio, simultaneous slots, streaming, ordinary media, swipes, chat scope, remount, read-only rendering and disposal passed`)
          } finally { await page.close() }
        }
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
