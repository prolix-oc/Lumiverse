import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  configFile: false, root: frontend, appType: 'custom', logLevel: 'warn', plugins: [react()],
  optimizeDeps: { entries: ['tests/message-list-scroll.fixture.tsx'] },
  resolve: { alias: { '@': `${frontend}/src` } },
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
server.middlewares.use(async (req, res, next) => {
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [] }))
    return
  }
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="icon" href="data:,"><style>html,body,#root{margin:0;height:100%;overflow:hidden}#root{display:flex;flex-direction:column}</style>
    <div id="root"></div><script type="module" src="/tests/message-list-scroll.fixture.tsx"></script>`))
})
await server.listen()
try {
  for (const name of (process.env.RESIZE_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [1280, 390]) {
        for (const cards of (process.env.RESIZE_CARDS || 'minimal,bubble').split(',').flatMap(card => Array(Number(process.env.RESIZE_REPEATS || 1)).fill(card))) {
          const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, reducedMotion: 'reduce' })
          try {
            const pageErrors = []
            page.on('pageerror', error => pageErrors.push(error.message))
            // Vite handles ErrorEvents before Playwright sees them in some
            // engines. Record the native event too, without filtering it.
            await page.addInitScript(() => {
              window.streamingResizeErrors = []
              window.addEventListener('error', event => window.streamingResizeErrors.push(event.message))
              window.addEventListener('unhandledrejection', event => window.streamingResizeErrors.push(String(event.reason)))
            })
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?mode=plain&delay=200&cards=${cards}`)
            const list = page.locator('[data-component="MessageList"]')
            await page.waitForFunction(() => {
              const list = document.querySelector('[data-component="MessageList"]')
              return list && list.scrollHeight > list.clientHeight && !list.querySelector('[data-display-pending]') && Number(getComputedStyle(list).opacity) === 1
            }, null, { timeout: 60000 })
            await page.evaluate(() => {
              const store = window.scrollFixtureStore
              const content = Array.from({ length: 160 }, (_, index) => `Review paragraph ${index}. Text for the scrolling test.`).join('\n\n')
              store.setState({ messages: store.getState().messages.map(message => message.id === 'message-119' ? { ...message, content, swipes: [content] } : message) })
            })
            await page.waitForFunction(() => {
              const row = document.querySelector('[data-virtual-index][data-message-id="message-119"]')
              return row?.offsetHeight > 3000 && row.textContent.includes('Review paragraph 159') && !row.querySelector('[data-display-pending]')
            })
            await page.waitForFunction(() => {
              const list = document.querySelector('[data-component="MessageList"]')
              return Math.abs(list.scrollHeight - list.scrollTop - list.clientHeight) <= 3
            })
            await list.evaluate(element => {
              element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
              element.scrollTop -= 1000
            })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            const initial = await page.evaluate(() => {
              const row = document.querySelector('[data-virtual-index][data-message-id="message-119"]')
              return { row: row.offsetHeight, total: row.parentElement.offsetHeight, top: document.querySelector('[data-component="MessageList"]').scrollTop }
            })
            await page.evaluate(() => {
              const store = window.scrollFixtureStore
              const content = store.getState().messages.at(-1).content + '\n\nEdited source'
              store.setState({ messages: store.getState().messages.map(message => message.id === 'message-119' ? { ...message, content, swipes: [content] } : message) })
            })
            await page.waitForFunction(() => document.querySelector('[data-message-id="message-119"] [data-display-pending]'))
            await page.evaluate(() => window.scrollFixtureStore.setState({
              isStreaming: true, streamingRenderMode: null, streamingGenerationType: 'regenerate',
              regeneratingMessageId: 'message-119', streamingContent: 'New generation',
            }))
            await page.waitForFunction(() => {
              const row = document.querySelector('[data-virtual-index][data-message-id="message-119"]')
              return row.textContent.includes('New generation') && !row.querySelector('[data-display-pending]')
            })
            await page.evaluate(() => window.scrollFixtureStore.setState({ streamingContent: Array.from({ length: 400 }, () => 'More streaming content.').join('\n\n') }))
            await page.waitForFunction(initial => {
              const row = document.querySelector('[data-virtual-index][data-message-id="message-119"]')
              return row.offsetHeight > initial.row + 1000
                && Math.abs((row.parentElement.offsetHeight - initial.total) - (row.offsetHeight - initial.row)) <= 2
            }, initial)
            assert(Math.abs((await list.evaluate(element => element.scrollTop)) - initial.top) <= 1, 'streamed growth preserves the unpinned viewport')
            // Exercise a shorter streaming revision after the larger lock
            // has committed, then ensure stream completion releases it.
            const locked = await page.locator('[data-virtual-index][data-message-id="message-119"]').evaluate(row => row.offsetHeight)
            await page.waitForFunction(() => {
              const body = document.querySelector('[data-message-id="message-119"] [data-component="MessageContent"] > div > div')
              return parseFloat(body.style.minHeight) >= body.offsetHeight - 1
            })
            await page.evaluate(() => window.scrollFixtureStore.setState({ streamingContent: 'Short revision' }))
            await page.waitForFunction(() => document.querySelector('[data-message-id="message-119"]').textContent.includes('Short revision'))
            assert((await page.locator('[data-virtual-index][data-message-id="message-119"]').evaluate(row => row.offsetHeight)) >= locked - 1, 'streaming shrink keeps the height lock')
            await page.evaluate(() => window.scrollFixtureStore.setState({ isStreaming: false, regeneratingMessageId: null, streamingContent: '' }))
            await page.waitForFunction(() => {
              const row = document.querySelector('[data-virtual-index][data-message-id="message-119"]')
              const body = row?.querySelector('[data-component="MessageContent"] > div > div')
              return body && body.style.minHeight === '' && row.textContent.includes('Edited source') && !row.querySelector('[data-display-pending]')
            })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            assert.deepEqual(await page.evaluate(() => window.streamingResizeErrors), [])
            assert.deepEqual(pageErrors, [])
            console.log(`${name} ${width}px ${cards}: regeneration, growth, shrink protection and stream completion passed without browser errors`)
          } finally { await page.close() }
        }
      }
    } finally { await runtime.close() }
  }
} finally { await server.close() }
