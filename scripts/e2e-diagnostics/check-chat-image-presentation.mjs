// Real controls, prose/HTML renderer and attachments. Controlled data; no live account.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { build } = require('esbuild')
const playwright = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({
  absWorkingDir: root, entryPoints: ['frontend/tests/chat-image-presentation.fixture.tsx'], outfile: 'image-fixture.js',
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'import.meta.url': '"http://fixture.test/unused-worker.js"' },
  plugins: [{ name: 'image-boundaries', setup(build) {
    build.onResolve({ filter: /^@\/store$/ }, args => ({ path: args.path, namespace: 'fixture-store' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture-store' }, () => ({ contents: 'import {create} from "zustand";export const useStore=create(()=>({}));', loader: 'js', resolveDir: root + '/frontend' }))
    build.onResolve({ filter: /^@\/i18n$/ }, args => ({ path: args.path, namespace: 'fixture-i18n' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: `import i18n from 'i18next';import {initReactI18next} from 'react-i18next';import settings from './src/i18n/locales/en/settings.json';import chat from './src/i18n/locales/en/chat.json';i18n.use(initReactI18next).init({lng:'en',resources:{en:{settings,chat}},initImmediate:false});export default i18n;export const changeUiLanguage=async()=>{};`, loader: 'js', resolveDir: root + '/frontend' }))
    build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'unused-worker' }))
    build.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default "unused-fixture-worker"', loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).text
const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
:root{--lumiverse-ui-scale:1;--lumiverse-text:#eee;--lumiverse-text-muted:#aaa;--lumiverse-bg:#19181f;--lumiverse-bg-deep:#19181f;--lumiverse-modal-backdrop:#000a;--lumiverse-border:#444;--lumiverse-primary:#b4a6ff;--lumiverse-primary-010:#b4a6ff19;--lumiverse-fill-subtle:#ffffff09}body{background:var(--lumiverse-bg);color:var(--lumiverse-text);font-family:Arial}button{color:inherit;background:#25232d;padding:8px;border:1px solid #777}#root{padding-top:var(--app-interactive-safe-top)}#message,#profile{margin:12px;max-width:900px;min-width:0}#profile{--prose-image-max-width:360px;--prose-image-max-height:360px}#message img{transition:none!important}@media(max-width:680px){:root{--app-interactive-safe-top:47px}}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`
// The app shell deliberately clips body overflow; chat owns its own scroll area.
const fixtureHtml = html.replace('</style>', '#root{overflow-y:auto;overflow-x:hidden}</style>')
const server = createServer((req, res) => {
  if (req.url.endsWith('/display-preprocess')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ items: JSON.parse(body).items.map(item => ({ content: item.rawContent, incrementalRawAppendSafe: true })) }))
    })
  } else if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(js) }
  else if (req.url.includes('/images/fixture-video-')) { res.writeHead(204); res.end() }
  else if (req.url.includes('.svg') || req.url.includes('/images/')) {
    res.setHeader('content-type', 'image/svg+xml')
    const tall = req.url.includes('tall') || req.url.includes('asset')
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${tall ? 400 : 1200}" height="${tall ? 1200 : 600}"><rect width="100%" height="100%" fill="#57506d"/><circle cx="50%" cy="50%" r="120" fill="#b4a6ff"/></svg>`)
  } else if (req.url.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('[]') }
  else { res.setHeader('content-type', 'text/html'); res.end(fixtureHtml) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
if (process.argv.includes('--serve')) { console.log(`Image presentation fixture: ${url}`); await new Promise(() => {}) }
try {
  for (const engine of (process.env.IMAGE_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const browser = await playwright[engine].launch({ timeout: 30000 })
    try {
      for (const width of [1280, 390]) for (const scale of [1, 1.25]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' })
        const errors = []; page.on('pageerror', error => errors.push(error.message))
        await page.goto(url)
        await page.evaluate(scale => document.documentElement.style.setProperty('--lumiverse-ui-scale', scale), scale)
        const sizes = page.getByRole('group', { name: 'Inline image size', exact: true })
        const aligns = page.getByRole('group', { name: 'Image alignment', exact: true })
        const targets = page.getByRole('group', { name: 'Apply to', exact: true })
        const targetLabels = ['Markdown / asset images', 'HTML / XML images', 'Attachments']
        for (const label of targetLabels) assert.equal(await targets.getByRole('checkbox', { name: label, exact: true }).isChecked(), true)
        assert.equal(await sizes.getByRole('button', { name: 'Default', exact: true }).getAttribute('aria-pressed'), 'true')
        assert.equal(await aligns.getByRole('button', { name: 'Left', exact: true }).getAttribute('aria-pressed'), 'true')
        const close = page.getByRole('button', { name: 'Close settings', exact: true })
        const reopen = page.getByRole('button', { name: 'Reopen settings', exact: true })
        await close.click()
        const markdown = page.locator('#message').getByRole('img', { name: 'Markdown', exact: true })
        await markdown.scrollIntoViewIfNeeded()
        assert.ok((await markdown.boundingBox()).width <= 240 * scale + 1)
        const profile = page.getByRole('img', { name: 'Profile preview', exact: true })
        await profile.scrollIntoViewIfNeeded()
        const originalProfile = await profile.boundingBox()
        for (const size of (process.env.IMAGE_SCOPES_ONLY ? [] : ['100', '75', '50', 'default'])) for (const alignment of ['Left', 'Center', 'Right']) {
          await reopen.click()
          const selectedSize = sizes.getByRole('button', { name: size === 'default' ? 'Default' : `${size}% × ${size}%`, exact: true })
          await selectedSize.focus(); await page.keyboard.press('Enter')
          const selectedAlignment = aligns.getByRole('button', { name: alignment, exact: true })
          await selectedAlignment.focus(); await page.keyboard.press('Space')
          assert.equal(await selectedSize.getAttribute('aria-pressed'), 'true')
          assert.equal(await selectedAlignment.getAttribute('aria-pressed'), 'true')
          for (const control of [selectedSize, selectedAlignment, close]) {
            const box = await control.boundingBox()
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= (width === 390 ? 47 : 0) - 1, 'controls fit below safe top')
          }
          await close.click()
          for (const alt of ['Markdown', 'Linked Markdown', '', 'Raw HTML', 'XML image', 'Portrait', 'PortraitSource', 'Island Markdown', 'Island HTML', 'Attachment', 'User attachment']) {
            const image = alt ? page.locator('#message').getByRole('img', { name: alt, exact: true }) : page.locator('#message img[alt=""]')
            await image.scrollIntoViewIfNeeded()
            await page.waitForFunction(img => img.complete && img.naturalWidth > 0, await image.elementHandle(), { timeout: 10000 }).catch(async error => {
              throw new Error(`${alt}: ${await image.evaluate(img => JSON.stringify({ src: img.currentSrc, complete: img.complete, width: img.naturalWidth, box: img.getBoundingClientRect().toJSON(), parent: img.parentElement.outerHTML }))}`, { cause: error })
            })
            const geometry = await image.evaluate(img => {
              const b = img.getBoundingClientRect(), parent = img.parentElement.getBoundingClientRect()
              return { x: b.x, right: b.right, width: b.width, height: b.height, parentX: parent.x, parentWidth: parent.width, ratio: img.naturalWidth / img.naturalHeight, objectFit: getComputedStyle(img).objectFit }
            })
            assert.ok(geometry.width > 0 && geometry.height > 0, `${alt} visible`)
            assert.ok(geometry.x >= -1 && geometry.right <= width + 1, `${alt} horizontally contained`)
            if (size !== 'default') {
              assert.ok(Math.abs(geometry.width / geometry.height - geometry.ratio) < 0.02, `${alt} keeps intrinsic aspect ratio`)
              assert.equal(geometry.objectFit, 'contain', `${alt} preserves visible proportions`)
              if (alt === 'Markdown') assert.ok(Math.abs(geometry.width - geometry.parentWidth * Number(size) / 100) < 3, `preset sets requested width: ${size} ${JSON.stringify(geometry)}`)
              if (alt === 'Markdown') {
                const space = geometry.parentWidth - geometry.width
                const offset = alignment === 'Left' ? 0 : alignment === 'Center' ? space / 2 : space
                assert.ok(Math.abs(geometry.x - geometry.parentX - offset) < 3, 'chosen alignment positions the image')
              }
            }
          }
          assert.ok(Math.abs((await profile.boundingBox()).width - originalProfile.width) < 1, 'profile preview unchanged')
          await page.getByRole('button', { name: 'Switch display mode' }).click()
        }
        // Snapshot the unmodified presentation, then verify each selected type independently.
        await reopen.click()
        await sizes.getByRole('button', { name: 'Default', exact: true }).click()
        await aligns.getByRole('button', { name: 'Left', exact: true }).click()
        await close.click()
        const samples = [
          ['Markdown', 0], ['Linked Markdown', 0], ['', 0], ['Portrait', 0], ['PortraitSource', 0], ['Island Markdown', 0],
          ['Raw HTML', 1], ['XML image', 1], ['Island HTML', 1], ['Attachment', 2], ['User attachment', 2],
        ]
        const sampleImage = alt => alt ? page.locator('#message').getByRole('img', { name: alt, exact: true }) : page.locator('#message img[alt=""]')
        const sampleState = async alt => {
          const image = sampleImage(alt)
          await image.scrollIntoViewIfNeeded()
          await page.waitForFunction(img => img.complete && img.naturalWidth > 0, await image.elementHandle(), { timeout: 10000 })
          return image.evaluate(img => {
            const b = img.getBoundingClientRect(), style = getComputedStyle(img)
            const frame = img.closest('button') || img
            const parent = frame.parentElement.getBoundingClientRect()
            return { width: b.width, height: b.height, marginLeft: style.marginLeft, marginRight: style.marginRight,
              frameWidth: frame.getBoundingClientRect().width, parentWidth: parent.width }
          })
        }
        const baseline = new Map()
        for (const [alt] of samples) baseline.set(alt, await sampleState(alt))
        const videoState = () => page.locator('#videos video').evaluateAll(videos => videos.map(video => {
          const rect = video.getBoundingClientRect(), parent = video.parentElement.getBoundingClientRect()
          return { x: rect.x - parent.x, y: rect.y - parent.y, width: rect.width, height: rect.height }
        }))
        const originalVideos = await videoState()
        for (let mask = 0; mask < 8; mask++) {
          await reopen.click()
          await sizes.getByRole('button', { name: '75% × 75%', exact: true }).click()
          await aligns.getByRole('button', { name: 'Center', exact: true }).click()
          for (const [index, label] of targetLabels.entries()) {
            const checkbox = targets.getByRole('checkbox', { name: label, exact: true })
            const checked = !!(mask & (1 << index))
            if (await checkbox.isChecked() !== checked) {
              if (index === 1) { await checkbox.focus(); await page.keyboard.press('Space') }
              else await checkbox.setChecked(checked)
            }
            assert.equal(await checkbox.isChecked(), checked)
            await checkbox.scrollIntoViewIfNeeded()
            const box = await checkbox.boundingBox()
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= (width === 390 ? 47 : 0) - 1, 'checkbox respects viewport and safe top')
          }
          await close.click()
          assert.deepEqual(await videoState(), originalVideos, 'image preferences preserve video layout')
          if (mask & 4) {
            const gap = await page.locator('#multiple-images button').evaluateAll(buttons =>
              buttons[1].getBoundingClientRect().top - buttons[0].getBoundingClientRect().bottom)
            assert.ok(gap >= 5, 'custom attachment rows retain spacing between images')
          }
          for (const [alt, category] of samples) {
            const actual = await sampleState(alt)
            if (mask & (1 << category)) {
              assert.ok(Math.abs(actual.frameWidth - actual.parentWidth * 0.75) < 3, alt + ': selected type uses requested width')
            } else {
              const original = baseline.get(alt)
              for (const property of ['width', 'height', 'marginLeft', 'marginRight']) {
                if (typeof actual[property] === 'number') assert.ok(Math.abs(actual[property] - original[property]) < 1, alt + ': unchecked type keeps ' + property)
                else assert.equal(actual[property], original[property], alt + ': unchecked type keeps ' + property)
              }
            }
          }
        }
        await reopen.click()
        await targets.getByRole('checkbox', { name: targetLabels[0], exact: true }).uncheck()
        await targets.getByRole('checkbox', { name: targetLabels[2], exact: true }).uncheck()
        await sizes.getByRole('button', { name: '75% × 75%', exact: true }).click()
        await aligns.getByRole('button', { name: 'Center', exact: true }).click()
        if (scale === 1) await page.screenshot({ path: join(tmpdir(), `chat-images-${engine}-${width}.png`), fullPage: false })
        await close.click()
        await page.waitForFunction(() => !document.querySelector('[data-display-pending]'))
        await page.getByRole('button', { name: 'Toggle message' }).click()
        await page.getByRole('button', { name: 'Toggle message' }).click()
        await page.waitForFunction(() => !document.querySelector('[data-display-pending]'))
        await page.reload()
        await page.waitForFunction(() => !document.querySelector('[data-display-pending]'))
        assert.equal(await sizes.getByRole('button', { name: '75% × 75%', exact: true }).getAttribute('aria-pressed'), 'true')
        assert.equal(await aligns.getByRole('button', { name: 'Center', exact: true }).getAttribute('aria-pressed'), 'true')
        for (const [index, label] of targetLabels.entries()) {
          assert.equal(await targets.getByRole('checkbox', { name: label, exact: true }).isChecked(), index === 1, 'selected types survive remount and reload')
        }
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${engine} ${width}px scale ${scale}: image target combinations, presets, keyboard, persistence and safe top passed`)
      }
    } finally { await browser.close() }
  }
} finally { server.close() }
