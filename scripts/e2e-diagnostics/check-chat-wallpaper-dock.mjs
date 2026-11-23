import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const bundle = await build({
  absWorkingDir: frontend,
  outfile: 'chat-wallpaper-dock.js',
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  stdin: {
    resolveDir: frontend,
    loader: 'tsx',
    contents: `
      import { useLayoutEffect, useState } from 'react'
      import { createPortal } from 'react-dom'
      import { createRoot } from 'react-dom/client'
      import WallpaperLayer from './src/components/shared/WallpaperLayer'
      import appStyles from './src/App.module.css'
      import chatStyles from './src/components/chat/ChatView.module.css'
      import './src/theme/variables.css'
      import './src/theme/reset.css'

      function Fixture() {
        const [backdrop, setBackdrop] = useState(null)
        const [duo, setDuo] = useState(false)
        const [scene, setScene] = useState(false)
        const [mounted, setMounted] = useState(true)
        useLayoutEffect(() => {
          window.wallpaperDockFixture = { setDuo, setScene, setMounted }
        }, [])
        const background = <>
          <WallpaperLayer wallpaper={{ image_id: 'fixture', type: 'image' }}
            settings={{ opacity: 1, fit: 'cover', blur: 0 }} hidden={scene} />
          <div className={chatStyles.sceneBackgroundLayer} data-test-scene
            style={{ backgroundImage: 'url(/api/v1/images/scene)', opacity: scene ? 1 : 0 }} />
          <div className={chatStyles.sceneTextContextLayer} data-test-scrim />
          <div className={chatStyles.wallpaperTransitionLayer} data-test-transition />
        </>
        return (
          <div className={appStyles.appFrame}>
            <div ref={setBackdrop} className={appStyles.chatBackdrop} data-test-backdrop />
            <div className={duo ? appStyles.app + ' ' + appStyles.duoApp : appStyles.app}
              style={{ '--spindle-dock-right': '60px' }}>
              <main className={duo ? appStyles.main + ' ' + appStyles.duoMain : appStyles.main}
                style={duo ? { left: 0, top: 0, width: '50%', height: '100%' } : undefined}>
                {mounted && <div className={chatStyles.container} data-test-chat>
                  {backdrop && !duo ? createPortal(background, backdrop) : background}
                  <button type="button" onClick={() => { document.body.dataset.clicked = 'true' }}>Chat action</button>
                </div>}
              </main>
            </div>
          </div>
        )
      }

      createRoot(document.getElementById('root')).render(<Fixture />)
    `,
  },
})
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const cases = [1200, 390].flatMap(width => [0.75, 1, 1.5].map(scale => ({ width, scale })))

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const runtime = await launchTestBrowser(engine)
  try {
    for (const { width, scale } of cases) {
      const mobile = width < 600
      const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, hasTouch: mobile })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await page.route('http://wallpaper.test/**', route => {
          if (new URL(route.request().url()).pathname.startsWith('/api/v1/images/')) {
            return route.fulfill({
              contentType: 'image/svg+xml',
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="royalblue"/></svg>',
            })
          }
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">'
              + '<style>' + css + '</style><div id="root"></div><script>' + js + '</script>',
          })
        })
        await page.goto('http://wallpaper.test/')
        await page.evaluate(scale => document.documentElement.style.setProperty('--lumiverse-ui-scale', scale), scale)
        const chat = page.locator('[data-test-chat]')
        const wallpaper = page.locator('[data-test-backdrop] > div').first()
        await wallpaper.waitFor()
        const viewport = { x: 0, y: 0, width, height: 844 }
        assert.deepEqual(await wallpaper.boundingBox(), viewport)
        assert.ok(Math.abs((await chat.boundingBox()).width - (width - 60 * scale)) <= 1)

        await page.evaluate(mobile => {
          document.documentElement.dataset.guideDocked = ''
          document.documentElement.style.setProperty(mobile ? '--guide-dock-bottom' : '--guide-dock-left', '240px')
        }, mobile)
        const insetChat = await chat.boundingBox()
        if (mobile) assert.ok(Math.abs(insetChat.height - (844 - 240 * scale)) <= 1)
        else assert.equal(insetChat.x, 240 * scale)
        assert.deepEqual(await wallpaper.boundingBox(), viewport)
        await page.getByRole('button', { name: 'Chat action' }).click()
        assert.equal(await page.locator('body').getAttribute('data-clicked'), 'true')
        for (const layer of ['scene', 'scrim', 'transition']) {
          assert.deepEqual(await page.locator('[data-test-' + layer + ']').boundingBox(), viewport)
        }
        await page.evaluate(() => window.wallpaperDockFixture.setScene(true))
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-test-scene]')).opacity === '1')

        await page.evaluate(() => window.wallpaperDockFixture.setDuo(true))
        await page.waitForFunction(() => document.querySelector('[data-test-backdrop]').childElementCount === 0)
        const duoChat = await chat.boundingBox()
        assert.ok(Math.abs(duoChat.width - width / 2) <= 1)
        assert.equal(duoChat.x, 0)
        assert.ok(Math.abs(duoChat.height - 844) <= 1)
        assert.deepEqual(await page.locator('[data-test-scene]').boundingBox(), duoChat)

        await page.evaluate(() => window.wallpaperDockFixture.setDuo(false))
        await wallpaper.waitFor()
        assert.deepEqual(await wallpaper.boundingBox(), viewport)
        await page.evaluate(() => window.wallpaperDockFixture.setMounted(false))
        await chat.waitFor({ state: 'detached' })
        assert.equal(await page.locator('[data-test-backdrop] > *').count(), 0)
        assert.deepEqual(errors, [])
        console.log(`${engine} ${width}px ${scale * 100}%: dock/scene coverage, Duo containment, input and cleanup pass`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await runtime.close()
  }
}
