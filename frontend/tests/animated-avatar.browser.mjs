import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { launchTestBrowser } from '../../scripts/e2e-diagnostics/browser-runtime.mjs'
import { animatedPng, animatedWebp } from '../../src/utils/animated-image.test-fixtures.ts'
import { transformAnimatedImage } from '../../src/utils/animated-image.ts'
import { imagesRoutes } from '../../src/routes/images.routes.ts'
import sharp from '../../src/utils/sharp-config.ts'

const sources = { apng: animatedPng(undefined, false, 0), webp: await animatedWebp(0) }
const thumbnails = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([id, source]) =>
  [id, await transformAnimatedImage(source, { width: 64, height: 64, quality: 90 })])))
const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), appType: 'custom', logLevel: 'warn',
  resolve: config.resolve, optimizeDeps: { entries: ['tests/animated-avatar.fixture.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
let cropCount = 0
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/api/v1/images/crop-animated') {
    const chunks = []
    for await (const data of req) chunks.push(data)
    const response = await imagesRoutes.request('/crop-animated', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (response.ok) {
      assert.equal((await sharp(bytes).metadata()).pages, 2)
      cropCount++
    }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    return res.end(bytes)
  }
  if (url.pathname.startsWith('/api/v1/images/')) {
    const id = url.pathname.split('/').pop()
    assert.equal(url.searchParams.get('thumbnail_version'), '3')
    res.setHeader('Content-Type', 'image/webp')
    return res.end(thumbnails[id])
  }
  if (req.url.split('?')[0] !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/tests/animated-avatar.fixture.tsx"></script>'))
})
await server.listen()
async function assertAnimating(page, image) {
  await image.waitFor({ state: 'visible' })
  await image.evaluate(async img => { await img.decode() })
  await page.waitForTimeout(250)
  const box = await image.boundingBox()
  const first = await page.screenshot({ clip: box, animations: 'allow' })
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(80 + i * 25)
    if (!(await page.screenshot({ clip: box, animations: 'allow' })).equals(first)) return
  }
  await page.screenshot({ path: '/private/tmp/animated-avatar-browser-failure.png' })
  assert.fail(`Image pixels never changed: ${await image.getAttribute('alt')} ${await image.getAttribute('src')}`)
}
try {
  for (const browserName of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(browserName)
    try {
      const page = await runtime.browser.newPage({ viewport: { width: 900, height: 850 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      cropCount = 0
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
      for (const type of ['apng', 'webp']) {
        await assertAnimating(page, page.getByAltText(type, { exact: true }))
        await assertAnimating(page, page.getByAltText(`${type} landing`, { exact: true }))
        const previousCrop = await page.getByAltText('Saved crop').evaluateAll(images => images[0]?.getAttribute('src') ?? null)
        await page.getByLabel('Upload avatar').setInputFiles({ name: `avatar.${type === 'apng' ? 'png' : 'webp'}`, mimeType: type === 'apng' ? 'image/png' : 'image/webp', buffer: sources[type] })
        const cropResponse = page.waitForResponse(response => response.url().endsWith('/images/crop-animated'))
        await page.getByRole('button', { name: 'Confirm', exact: true }).click()
        assert.equal((await cropResponse).status(), 200)
        await page.waitForFunction(previous => {
          const src = document.querySelector('img[alt="Saved crop"]')?.getAttribute('src')
          return src && src !== previous
        }, previousCrop)
        await page.getByRole('status').filter({ hasText: 'avatar.webp image/webp' }).waitFor()
        await assertAnimating(page, page.getByAltText('Saved crop'))
      }
      assert.equal(cropCount, 2)
      assert.deepEqual(errors, [])
      console.log(`${browserName}: animated gallery, landing images, APNG/WebP crop and MIME passed`)
      await page.close()
    } finally { await runtime.close() }
  }
} finally { await server.close() }
// Imported backend services can own background intervals in a standalone run.
process.exit(0)
