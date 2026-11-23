import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

// Real drawer, organizer, CSS, DnD sensors and pointer capture; isolated settings
// persistence and panel registry keep the check independent of private accounts.
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const result = await build({
  absWorkingDir: frontend, outfile: 'sidebar.js', bundle: true, write: false,
  format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'sidebar-fixture', setup(build) {
    build.onResolve({ filter: /^@\/store$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    build.onResolve({ filter: /^@\/lib\/drawer-tab-registry$/ }, () => ({ path: 'registry', namespace: 'fixture' }))
    build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }))
    build.onResolve({ filter: /^\.\/TabPanelContent$/ }, () => ({ path: 'panel', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: frontend, loader: 'tsx', contents: {
      store: `import { create } from 'zustand'
        const defaults = { side: 'right', tabSize: 'compact', verticalPosition: 15, panelWidthMode: 'default',
          showTabLabels: true, hiddenTabIds: [], tabOrder: [], layout: [
            {type:'tab',tabId:'profile'}, {type:'tab',tabId:'connections'}, {type:'tab',tabId:'lorebook'}] }
        export const useStore = create(set => ({ drawerOpen:true, drawerTab:'profile', settingsLoaded:true,
          drawerSettings: JSON.parse(localStorage.getItem('drawer') || 'null') || defaults,
          drawerTabs:[], extensions:[], hiddenPlacements:[], isGroupChat:false, pendingActiveTabReset:null,
          modalProps:{}, activeModal:null, efficiencyMode:true,
          openDrawer:id=>set(s=>({drawerOpen:true,drawerTab:id ?? s.drawerTab})),
          closeDrawer:()=>set({drawerOpen:false}), setDrawerTab:drawerTab=>set({drawerTab}),
          setSetting:(key,value)=>{if(key==='drawerSettings')localStorage.setItem('drawer',JSON.stringify(value));set({[key]:value})},
          openSettings:()=>{}, clearPendingActiveTabReset:()=>{},
          openModal:(activeModal,modalProps={})=>set({activeModal,modalProps}), closeModal:()=>set({activeModal:null}),
        }))
        window.sidebarStore=useStore;
        window.resetSidebar=(layout)=>{const drawerSettings={...defaults,layout};localStorage.removeItem('drawer');useStore.setState({drawerOpen:true,drawerTab:'profile',drawerSettings,activeModal:null})}`,
      registry: `import { Folder } from 'lucide-react'
        export const DRAWER_TABS=['profile','connections','lorebook'].map(id=>({id,tabName:id,shortName:id,tabIcon:Folder,keywords:[],tabDescription:id}));
        export const adaptExtensionTabs=()=>[]; export const sanitizeHiddenDrawerTabIds=ids=>ids||[];
        export const preloadDrawerTab=()=>{}; export const isDrawerTabCore=id=>id==='profile';`,
      panel: `import {useStore} from '@/store';export default function Panel(){return <div data-test-panel>{useStore(s=>s.drawerTab)}</div>}`,
      i18n: `import i18n from 'i18next';export default i18n`,
    }[path] } ))
  } }],
  stdin: { resolveDir: frontend, loader: 'tsx', contents: `
    import {createRoot} from 'react-dom/client'
    import i18n from 'i18next'; import {initReactI18next} from 'react-i18next'
    import {useStore} from '@/store'
    import ViewportDrawer from './src/components/panels/ViewportDrawer'
    import ConfigureDrawerTabsModal from './src/components/modals/ConfigureDrawerTabsModal'
    import panels from './src/i18n/locales/en/panels.json'
    import modals from './src/i18n/locales/en/modals.json'
    import settings from './src/i18n/locales/en/settings.json'
    import './src/theme/variables.css';import './src/theme/reset.css'
    function Fixture(){const activeModal=useStore(s=>s.activeModal);return <main data-app-root><ViewportDrawer/>{activeModal==='configureTabs'&&<ConfigureDrawerTabsModal/>}</main>}
    i18n.use(initReactI18next).init({lng:'en',resources:{en:{panels,modals,settings}}}).then(()=>createRoot(document.getElementById('root')).render(<Fixture/>))
  ` },
})
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
const tabs = ['profile', 'connections', 'lorebook'].map(tabId => ({ type: 'tab', tabId }))
const folder = { type: 'folder', id: 'tools', name: 'Tools', icon: 'folder', children: ['profile'] }

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const runtime = await launchTestBrowser(engine)
  try {
    for (const [width, touch] of [[1280, false], [390, true], [1024, true]]) {
      for (const scale of [1, 1.25]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.route('http://sidebar.test/**', route => route.fulfill({ contentType: 'text/html', body:
          '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css
          + `:root{--lumiverse-ui-scale:${scale};--app-interactive-safe-top:0px}body{zoom:${scale}}</style><div id="root"></div><script>` + js + '</script>' }))
        await page.goto('http://sidebar.test/')
        const item = id => page.locator(`[data-drawer-drag-id="${id}"]`)
        const folderButton = () => item('folder:tools').getByRole('button')
        const activate = locator => touch ? locator.tap() : locator.click()
        const layout = () => page.evaluate(() => window.sidebarStore.getState().drawerSettings.layout)
        const reset = async next => {
          const done = page.getByRole('button', { name: 'Done arranging icons', exact: true })
          if (await done.count()) await done.click()
          await page.evaluate(next => window.resetSidebar(next), next)
          await page.waitForFunction(expected => JSON.stringify(window.sidebarStore.getState().drawerSettings.layout) === JSON.stringify(expected), next)
          // dnd-kit removes its post-drag native click listener after 50ms.
          await page.waitForTimeout(220)
        }
        const arrange = async () => {
          if (!touch) return
          await item('tab:profile').click({ button: 'right' })
          await page.getByRole('button', { name: 'Arrange sidebar icons', exact: true }).click()
        }
        const drag = async (source, target, { dwell = false, fraction = 0.5, cancel = false } = {}) => {
          await source.scrollIntoViewIfNeeded()
          const a = await source.boundingBox()
          assert(a)
          await source.evaluate(el => el.addEventListener('pointerdown', event => { window.dragPointerId = event.pointerId }, { once: true }))
          await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
          await page.mouse.down()
          await target.scrollIntoViewIfNeeded()
          const b = await target.boundingBox()
          assert(b)
          const horizontal = width <= 600
          const x = b.x + b.width * (horizontal ? fraction : 0.5)
          const y = b.y + b.height * (horizontal ? 0.5 : fraction)
          await page.mouse.move(x, y, { steps: 8 })
          if (dwell) await page.waitForFunction(() => !!document.querySelector('[data-drawer-drop-ready="true"]'))
          if (cancel) {
            if (touch) await source.dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.dragPointerId) })
            else await page.keyboard.press('Escape')
          }
          await page.mouse.up()
        }
        try {
          await item('tab:profile').waitFor()
          await reset(tabs)
          await arrange()
          await drag(item('tab:profile'), item('tab:connections'))
          assert.deepEqual((await layout()).map(item => item.tabId), ['connections', 'profile', 'lorebook'])
          await page.reload()
          await item('tab:profile').waitFor()
          assert.deepEqual((await layout()).map(item => item.tabId), ['connections', 'profile', 'lorebook'])

          await reset(tabs)
          await arrange()
          await drag(item('tab:profile'), item('tab:connections'), { dwell: true })
          assert.deepEqual((await layout()).find(item => item.type === 'folder').children, ['connections', 'profile'])

          await reset([folder, tabs[1], tabs[2]])
          await page.evaluate(() => {
            window.savedAnchor = document.querySelector('[data-spindle-scope="drawer-tab:profile"]')
            window.savedWidget = document.createElement('input')
            window.savedWidget.value = 'Extension draft'
            window.savedWidget.hidden = true
            window.savedAnchor.append(window.savedWidget)
          })
          await activate(folderButton())
          assert.equal(await page.evaluate(() => window.savedAnchor === document.querySelector('[data-spindle-scope="drawer-tab:profile"]') && window.savedWidget.isConnected), true)
          await activate(item('tab:profile').getByRole('button'))
          assert.equal(await folderButton().getAttribute('aria-expanded'), 'true')
          assert.equal(await page.locator('[data-test-panel]').textContent(), 'profile')
          await arrange()
          if (touch) {
            await activate(folderButton())
            assert.equal(await folderButton().getAttribute('aria-expanded'), 'false')
            await activate(folderButton())
            assert.equal(await folderButton().getAttribute('aria-expanded'), 'true')
          }
          assert.equal(await page.evaluate(() => window.savedWidget.isConnected && window.savedWidget.value === 'Extension draft'), true)
          const before = await layout()
          await drag(item('tab:connections'), item('tab:lorebook'), { cancel: true })
          assert.deepEqual(await layout(), before)
          await drag(item('tab:connections'), item('folder:tools'))
          assert.deepEqual((await layout()).find(item => item.type === 'folder').children, ['profile', 'connections'])
          await drag(item('tab:profile'), page.locator('[data-drawer-edge-drop="drawer-layout:root-end"]'))
          assert.equal((await layout()).at(-1).tabId, 'profile')

          if (touch) await page.getByRole('button', { name: 'Done arranging icons', exact: true }).click()
          await folderButton().click({ button: 'right' })
          await page.getByRole('button', { name: 'Customize Folder', exact: true }).last().click()
          const name = page.getByRole('textbox', { name: 'Folder name', exact: true })
          await name.waitFor()
          await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Folder name')
          await name.fill('Review tools')
          await page.keyboard.press('Escape')
          assert.equal((await layout()).find(item => item.type === 'folder').name, 'Review tools')
          await page.reload()
          await item('folder:tools').waitFor()
          assert.equal((await layout()).find(item => item.type === 'folder').name, 'Review tools')
          assert.deepEqual(errors, [])
          console.log(`${engine} ${width}px touch=${touch} scale=${scale}: reorder, reload, dwell folder, expansion, cancel, membership, root exit and organizer passed`)
        } catch (error) {
          console.error({ engine, width, touch, scale, errors, layout: await layout() })
          throw error
        } finally { await page.close() }
      }
    }
  } finally { await runtime.close() }
}
