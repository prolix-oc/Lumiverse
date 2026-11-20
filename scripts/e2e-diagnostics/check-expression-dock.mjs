import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const bundle = await build({
  absWorkingDir: frontend,
  outfile: 'expression-dock.js',
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{
    name: 'expression-dock-store',
    setup(build) {
      build.onResolve({ filter: /^@\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        resolveDir: frontend,
        contents: `
          import { create } from 'zustand'
          import { createExpressionSlice } from './src/store/slices/expressions'
          export const useStore = create((...args) => ({
            ...createExpressionSlice(...args),
            activeCharacterId: 'actor',
            activeChatId: 'chat',
            activeChatMetadata: {},
            characters: [{ id: 'actor', name: 'Actor' }],
            groupCharacterIds: [],
            mutedCharacterIds: [],
          }))
        `,
      }))
    },
  }],
  stdin: {
    resolveDir: frontend,
    loader: 'tsx',
    contents: `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import i18next from 'i18next'
      import { initReactI18next } from 'react-i18next'
      import { useStore } from '@/store'
      import useIsMobile from './src/hooks/useIsMobile'
      import ExpressionDisplay from './src/components/chat/expressions/ExpressionDisplay'
      import chat from './src/i18n/locales/en/chat.json'
      import appStyles from './src/App.module.css'
      import chatStyles from './src/components/chat/ChatView.module.css'
      import './src/theme/variables.css'
      import './src/theme/reset.css'

      function Fixture() {
        const [side, setSide] = useState(null)
        const [galleryOpen, setGalleryOpen] = useState(false)
        const isMobile = useIsMobile()
        const portraitRail = side && (
          <div className={[
            chatStyles.portraitSide,
            side === 'left' ? chatStyles.portraitSideLeft : chatStyles.portraitSideRight,
            galleryOpen && chatStyles.portraitSideOpen,
          ].filter(Boolean).join(' ')}>
            {side === 'left' && <div style={{ flex: 1 }} />}
            <button
              className={[chatStyles.portraitTab, side === 'left' ? chatStyles.portraitTabLeft : chatStyles.portraitTabRight].join(' ')}
              data-test-gallery
              aria-expanded={galleryOpen}
              onClick={() => setGalleryOpen(!galleryOpen)}
            >Gallery</button>
            {side === 'right' && <div style={{ flex: 1 }} />}
          </div>
        )
        return (
          <main className={appStyles.app} style={{ '--spindle-dock-right': '60px' }}>
            <div className={chatStyles.container}>
              <div className={chatStyles.body}>
                <div className={chatStyles.chatColumn + ' ' + chatStyles.chatColumnCentered} data-test-chat>Chat</div>
              </div>
              <ExpressionDisplay isMobile={isMobile} onSideDockChange={setSide} />
              {portraitRail}
            </div>
          </main>
        )
      }

      Promise.all([
        i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { chat } } }),
        fetch('/saved-settings').then(response => response.json()),
      ]).then(([, saved]) => {
        useStore.setState(state => ({ expressionDisplay: { ...state.expressionDisplay, ...saved } }))
        createRoot(document.getElementById('root')).render(<Fixture />)
      })
    `,
  },
})
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const sprite = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="250"><rect width="150" height="250" fill="royalblue"/></svg>'

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const runtime = await launchTestBrowser(engine)
  try {
    for (const width of [1200, 390]) {
      const mobile = width < 600
      const page = await runtime.browser.newPage({ viewport: { width, height: 844 }, hasTouch: mobile })
      try {
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        let saved = { x: 72, y: 90, clickThrough: true }
        await page.route('http://expression.test/**', route => {
          const path = new URL(route.request().url()).pathname
          if (path === '/saved-settings') return route.fulfill({ json: saved })
          if (path === '/api/v1/settings/expressionDisplay') {
            saved = route.request().postDataJSON().value
            return route.fulfill({ json: { key: 'expressionDisplay', value: saved } })
          }
          if (path.endsWith('/expressions/groups')) return route.fulfill({ json: {} })
          if (path.endsWith('/expressions')) {
            return route.fulfill({ json: { enabled: true, defaultExpression: 'smile', mappings: { smile: 'sprite' } } })
          }
          if (path.startsWith('/api/v1/images/')) return route.fulfill({ contentType: 'image/svg+xml', body: sprite })
          return route.fulfill({
            contentType: 'text/html',
            body: '<meta name="viewport" content="width=device-width, initial-scale=1">'
              + '<style>' + css + (mobile ? ':root{--app-interactive-safe-top:47px}' : '')
              + '</style><div id="root"></div><script>' + js + '</script>',
          })
        })
        await page.goto('http://expression.test/')
        const options = page.getByRole('button', { name: 'Expression display options' })
        const dock = page.locator('[data-expression-dock]')
        const chat = page.locator('[data-test-chat]')
        const setSidebarWidth = (side, width) => page.locator('main').evaluate((el, { side, width }) => {
          el.style.setProperty('--chat-drawer-' + side, width + 'px')
        }, { side, width })
        const expectChatRight = right => page.waitForFunction(right => {
          const chat = document.querySelector('[data-test-chat]')
          return Math.abs(chat.getBoundingClientRect().right - right) <= 1
        }, right)
        await page.getByRole('img', { name: 'smile' }).waitFor()
        const originalChat = await chat.boundingBox()
        const originalSprite = await page.getByRole('img', { name: 'smile' }).boundingBox()

        const activate = locator => mobile ? locator.tap() : locator.click()
        const waitForWrite = () => page.waitForResponse(response => response.url().endsWith('/settings/expressionDisplay'))

        async function choose(name, submenu) {
          await activate(options)
          if (submenu) await activate(page.getByRole('button', { name: submenu, exact: true }))
          const write = waitForWrite()
          await activate(page.getByRole('button', { name, exact: true }))
          assert.equal((await write).ok(), true)
        }

        await choose('Half-dock view')
        assert.equal(await dock.getAttribute('data-expression-dock'), mobile ? 'top' : 'right')
        const placementKey = mobile ? 'mobilePlacement' : 'placement'
        const otherPlacementKey = mobile ? 'placement' : 'mobilePlacement'
        const backgroundKey = mobile ? 'mobileDockBackground' : 'dockBackground'
        const otherBackgroundKey = mobile ? 'dockBackground' : 'mobileDockBackground'
        assert.equal(await dock.getAttribute('data-dock-background'), mobile ? 'true' : null)
        assert.equal(saved[placementKey], 'dock')
        assert.equal(saved[otherPlacementKey], 'floating')
        assert.equal(saved[otherBackgroundKey], !mobile)
        if (!mobile) {
          await page.setViewportSize({ width: 390, height: 844 })
          await dock.waitFor({ state: 'detached' })
          await page.getByRole('img', { name: 'smile' }).waitFor()
          await page.setViewportSize({ width, height: 844 })
          await dock.waitFor()
          assert.equal(await dock.getAttribute('data-expression-dock'), 'right')
        }
        if (mobile) {
          await choose('Hide Dock Background')
          assert.equal(await dock.getAttribute('data-dock-background'), null)
          assert.equal(saved[backgroundKey], false)
          assert.equal(saved[otherBackgroundKey], false)
          await page.reload()
          await dock.waitFor()
          assert.equal(await dock.getAttribute('data-dock-background'), null)
        }
        const handle = page.getByRole('separator', { name: 'Resize expression dock' })
        const gallery = page.getByRole('button', { name: 'Gallery', exact: true })
        const resizeHighlight = () => handle.evaluate(el => getComputedStyle(el).boxShadow)
        if (!mobile) {
          await page.mouse.move(0, 0)
          assert.equal(await resizeHighlight(), 'none')
          await handle.hover()
          assert.notEqual(await resizeHighlight(), 'none')
          await page.mouse.move(0, 0)
          assert.equal(await resizeHighlight(), 'none')
          await page.keyboard.press('Tab')
          await handle.focus()
          assert.notEqual(await resizeHighlight(), 'none')
          const galleryRect = await gallery.boundingBox()
          const rightDock = await dock.boundingBox()
          assert.ok(Math.abs(galleryRect.x + galleryRect.width - rightDock.x - rightDock.width) <= 1)
          await gallery.click()
          await page.waitForFunction(x => document.querySelector('[data-test-gallery]').getBoundingClientRect().x < x, galleryRect.x)
          assert.equal(await gallery.getAttribute('aria-expanded'), 'true')
          await gallery.click()
        } else {
          await page.mouse.move(0, 0)
          assert.equal(await resizeHighlight(), 'none')
        }
        assert.equal(await handle.getAttribute('aria-valuenow'), mobile ? '20' : '25')
        await choose('Full', 'Dock Size…')
        const chatRect = await chat.boundingBox()
        const dockRect = await dock.boundingBox()
        if (mobile) assert.equal(dockRect.y, 47)
        assert.ok(mobile
          ? Math.abs(chatRect.y - dockRect.y - dockRect.height) <= 1
          : Math.abs(dockRect.x - chatRect.x - chatRect.width) <= 1)

        const spriteImage = page.getByRole('img', { name: 'smile' })
        const sizeKey = mobile ? 'dockHeightPercent' : 'dockWidthPercent'
        const otherSizeKey = mobile ? 'dockWidthPercent' : 'dockHeightPercent'
        const originalSize = mobile ? 40 : 50
        assert.equal(await handle.getAttribute('aria-valuenow'), String(originalSize))

        async function assertArtworkShrank() {
          const currentDock = await dock.boundingBox()
          const artwork = await spriteImage.boundingBox()
          assert.ok(currentDock[mobile ? 'height' : 'width'] < dockRect[mobile ? 'height' : 'width'])
          assert.ok(artwork.height < dockRect.height && artwork.width < dockRect.width)
          assert.ok(Math.abs(artwork.y + artwork.height - currentDock.y - currentDock.height) <= 1)
          assert.equal(await spriteImage.evaluate(el => getComputedStyle(el).objectPosition), '50% 100%')
        }

        if (!mobile) {
          // A sidebar narrower than the same-side dock is already accounted for.
          await setSidebarWidth('right', 300)
          await expectChatRight(dockRect.x)
          // A wider sidebar owns only the part that extends into chat.
          await setSidebarWidth('right', 700)
          await expectChatRight(width - 700)
          // Opposite edges are independent.
          await setSidebarWidth('left', 220)
          assert.equal((await chat.boundingBox()).x, 220)
          await setSidebarWidth('left', 0)
        }

        const grip = await handle.boundingBox()
        const x = grip.x + grip.width / 2
        const y = grip.y + grip.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + (mobile ? 0 : 135), y - (mobile ? 80 : 0), { steps: 4 })
        await page.waitForFunction(size => {
          const grip = document.querySelector('[data-expression-dock] [role=separator]')
          return Number(grip.getAttribute('aria-valuenow')) < size
        }, originalSize)
        await assertArtworkShrank()
        if (!mobile) {
          await expectChatRight(width - 700)
          await setSidebarWidth('right', 0)
        }
        assert.equal(saved[sizeKey], originalSize, 'drag preview is local')
        assert.notEqual(await resizeHighlight(), 'none', 'dragging keeps the edge highlighted')
        const dragWrite = waitForWrite()
        await page.mouse.up()
        assert.equal((await dragWrite).ok(), true)
        assert.ok(saved[sizeKey] < originalSize)
        assert.equal(saved[otherSizeKey], mobile ? 25 : 20)

        await handle.focus()
        const keyWrite = waitForWrite()
        await page.keyboard.press('End')
        assert.equal((await keyWrite).ok(), true)
        assert.equal(saved[sizeKey], originalSize)

        await choose('Medium', 'Dock Size…')
        const mediumSize = mobile ? 30 : 35
        assert.equal(await handle.getAttribute('aria-valuenow'), String(mediumSize))
        await assertArtworkShrank()

        if (!mobile) {
          await choose('Move Dock Left')
          assert.equal(await dock.getAttribute('data-expression-dock'), 'left')
          const leftDock = await dock.boundingBox()
          assert.ok(Math.abs((await chat.boundingBox()).x - leftDock.x - leftDock.width) <= 1)
          assert.ok(Math.abs((await gallery.boundingBox()).x - leftDock.x) <= 1)
          await setSidebarWidth('left', 280)
          assert.ok(Math.abs((await gallery.boundingBox()).x - leftDock.x - 280) <= 1)
          assert.ok(Math.abs((await chat.boundingBox()).x - leftDock.x - leftDock.width) <= 1)
          await setSidebarWidth('left', 520)
          assert.ok(Math.abs((await chat.boundingBox()).x - 520) <= 1)
          await setSidebarWidth('left', 0)
          await handle.focus()
          const leftKeyWrite = waitForWrite()
          await page.keyboard.press('ArrowLeft')
          assert.equal((await leftKeyWrite).ok(), true)
          assert.equal(saved[sizeKey], mediumSize - 2)
          await assertArtworkShrank()
          await choose('Medium', 'Dock Size…')

          await page.mouse.move(0, 0)
          await chat.click()
          await options.evaluate(el => el.blur())
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-expression-dock] button')).opacity === '0')
          await dock.hover()
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-expression-dock] button')).opacity === '1')
          await options.focus()
          await page.keyboard.press('Enter')
          await page.waitForFunction(() => document.activeElement?.textContent === 'Switch Expression…')
          await page.keyboard.press('Escape')
          await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Expression display options')
          // The gallery follows the workspace edge when a guide shifts it.
          await page.evaluate(() => {
            document.documentElement.dataset.guideDocked = ''
            document.documentElement.style.setProperty('--guide-dock-left', '240px')
          })
          assert.equal((await dock.boundingBox()).x, 240)
        }

        await choose('Show Dock Background')
        assert.equal(saved[backgroundKey], true)
        assert.equal(saved[otherBackgroundKey], !mobile)
        assert.notEqual(await dock.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
        await page.reload()
        await dock.waitFor()
        assert.equal(await dock.getAttribute('data-dock-background'), 'true')
        assert.equal(await handle.getAttribute('aria-valuenow'), String(mediumSize))
        if (!mobile) {
          assert.equal(await dock.getAttribute('data-expression-dock'), 'left')
          await choose('Move Dock Right')
          assert.equal(await dock.getAttribute('data-expression-dock'), 'right')
        }
        await spriteImage.waitFor()
        await assertArtworkShrank()
        await choose('Hide Dock Background')
        assert.equal(await dock.getAttribute('data-dock-background'), null)
        if (!mobile) await setSidebarWidth('right', 280)
        await choose('Floating view')
        assert.equal(await dock.count(), 0)
        assert.equal(saved[placementKey], 'floating')
        if (!mobile) {
          await expectChatRight(width - 280)
          await setSidebarWidth('right', 0)
        }
        assert.deepEqual(await chat.boundingBox(), originalChat)
        await page.getByRole('img', { name: 'smile' }).waitFor()
        assert.deepEqual(await page.getByRole('img', { name: 'smile' }).boundingBox(), originalSprite)
        assert.equal(saved.clickThrough, true)
        if (!mobile) {
          await page.setViewportSize({ width: 390, height: 844 })
          await choose('Half-dock view')
          assert.equal(await dock.getAttribute('data-expression-dock'), 'top')
          await page.setViewportSize({ width, height: 844 })
          await dock.waitFor({ state: 'detached' })
          assert.equal(saved.placement, 'floating')
          assert.equal(saved.mobilePlacement, 'dock')
        }
        assert.deepEqual(errors, [])
        console.log(`${engine} ${width}px: dock resizing, hover highlight, gallery alignment, and persistence pass`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await runtime.close()
  }
}
