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
      import { useState } from 'react'
      import { createPortal } from 'react-dom'
      import { createRoot } from 'react-dom/client'
      import WallpaperLayer from './src/components/shared/WallpaperLayer'
      import appStyles from './src/App.module.css'
      import chatStyles from './src/components/chat/ChatView.module.css'
      import './src/theme/variables.css'
      import './src/theme/reset.css'

      function Fixture() {
        const [backdrop, setBackdrop] = useState(null)
        return (
          <div className={appStyles.appFrame}>
            <div ref={setBackdrop} className={appStyles.chatBackdrop} data-test-backdrop />
            <main className={appStyles.app} style={{ '--spindle-dock-right': '60px' }}>
              <div className={chatStyles.container} data-test-chat>
                {backdrop && createPortal(
                  <WallpaperLayer wallpaper={{ image_id: 'fixture', type: 'image' }}
                    settings={{ opacity: 1, fit: 'cover', blur: 0 }} />,
                  backdrop,
                )}
                <button type="button" onClick={() => { document.body.dataset.clicked = 'true' }}>Chat action</button>
              </div>
            </main>
          </div>
        )
      }

      createRoot(document.getElementById('root')).render(<Fixture />)
    `,
  },
})
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const runtime = await launchTestBrowser(engine)
  try {
    for (const width of [1200, 390]) {
      const mobile = width < 600
      const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, hasTouch: mobile })
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
            body: '<meta name="viewport" content="width=device-width, initial-scale=1">'
              + '<style>' + css + '</style><div id="root"></div><script>' + js + '</script>',
          })
        })
        await page.goto('http://wallpaper.test/')
        const chat = page.locator('[data-test-chat]')
        const wallpaper = page.locator('[data-test-backdrop] > div')
        await wallpaper.waitFor()
        const viewport = { x: 0, y: 0, width, height: 844 }
        assert.deepEqual(await wallpaper.boundingBox(), viewport)
        assert.equal((await chat.boundingBox()).width, width - 60)

        await page.evaluate(mobile => {
          document.documentElement.dataset.guideDocked = ''
          document.documentElement.style.setProperty(mobile ? '--guide-dock-bottom' : '--guide-dock-left', '240px')
        }, mobile)
        const insetChat = await chat.boundingBox()
        if (mobile) assert.ok(Math.abs(insetChat.height - 604) <= 1)
        else assert.equal(insetChat.x, 240)
        assert.deepEqual(await wallpaper.boundingBox(), viewport)
        await page.getByRole('button', { name: 'Chat action' }).click()
        assert.equal(await page.locator('body').getAttribute('data-clicked'), 'true')
        console.log(`${engine} ${width}px: wallpaper covers the full viewport across dock insets`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await runtime.close()
  }
}
