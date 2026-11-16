// Real placement helpers and pop-out JSX; only the store facade and native IPC
// are controlled. Rust tests separately validate native window permissions.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const stubs = {
  '@/store': `import {create} from 'zustand';
    import {createSpindlePlacementSlice} from './src/store/slices/spindle-placement';
    export const useStore=create((...args)=>({...createSpindlePlacementSlice(...args),
      spindleSettings:{infoLoggingEnabled:false},
      extensions:[{id:'demo',name:'Demo',enabled:true,has_frontend:true}]}));`,
  './components-helper': 'export const destroyComponentsForTarget=()=>{};',
  './preset-editor-helper': `export const getPresetEditorState=()=>({open:false,presetId:null,activeTabId:null,preset:null}),
    subscribePresetEditorState=()=>()=>{},setPresetEditorActiveTab=()=>{},setPresetEditorController=()=>{},
    syncPresetEditorState=()=>{},updatePresetEditorDraft=()=>{},flushPresetEditorDraft=async()=>{};`,
}
const bundle = await build({
  absWorkingDir: frontend, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  stdin: { resolveDir: frontend, loader: 'tsx', contents: `
    import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';
    async function main(){
      const mode=new URLSearchParams(location.search).get('mode');const calls=[];
      if(mode!=='web'){
        mockWindows('widget-fixture');
        mockIPC((command,args)=>{calls.push({command,args});if(command==='plugin:window|scale_factor')return 2;}, {shouldMockEvents:true});
        if(mode==='mobile')window.__LUMIVERSE_MOBILE__=true;
      }
      const {useStore}=await import('@/store');
      const {createFloatWidgetHandle}=await import('@/lib/spindle/placement-helper');
      const api=await import('@/lib/desktop-floating-widget');
      const {createRoot}=await import('react-dom/client');
      const {emit}=await import('@tauri-apps/api/event');
      const handle=createFloatWidgetHandle('demo',{width:320,height:240,chromeless:false},()=>{},1);
      handle.root.innerHTML='<button id="extension-control">Extension control</button>';
      let clicks=0;handle.root.firstChild.onclick=()=>{clicks++};
      const root=createRoot(document.getElementById('root'));
      if(api.isDesktopFloatingWidgetWindow()){
        const {default:Host}=await import('@/components/spindle/DesktopFloatingWidgetHost');
        root.render(<Host extensionAvailable/>);
      }else document.getElementById('root').append(handle.root);
      window.fixture={handle,store:useStore,api,calls,emit,get clicks(){return clicks},
        unmount(){root.unmount();handle.destroy()}};
    }main().catch(error=>{setTimeout(()=>{throw error})});
  ` },
  plugins: [{ name: 'widget-fixture-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path)
      ? { path: args.path, namespace: 'stub' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: frontend }))
  } }],
})
const js = bundle.outputFiles[0].text
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/fixture.js' ? js : '<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
try {
  for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const [mode, width] of [['native', 1280], ['web', 1280], ['web', 390], ['mobile', 390]]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 900 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.goto(`${base}/?mode=${mode}&desktopWidgetExtension=demo&desktopWidgetIndex=0&desktopWidgetTitle=Demo&desktopWidgetWidth=1720&desktopWidgetHeight=1362`)
        await page.waitForFunction(() => !!window.fixture)
        const state = () => page.evaluate(() => {
          const { fixture: f } = window
          const widget = f.store.getState().floatWidgets[0]
          return { width: widget.width, height: widget.height, native: f.api.isDesktopFloatingWidgetWindow(), calls: f.calls }
        })
        await page.locator('#extension-control').click()
        assert.equal(await page.evaluate(() => window.fixture.clicks), 1)
        assert.equal((await state()).native, mode === 'native')
        if (mode === 'native') {
          await page.waitForFunction(() => window.fixture.calls.some(c => c.command === 'sync_desktop_widget_size' && c.args.width === 1720 && c.args.height === 1362))
          await page.evaluate(() => window.fixture.handle.setSize(2500, 1500))
          await page.waitForFunction(() => window.fixture.calls.some(c => c.command === 'sync_desktop_widget_size' && c.args.width === 2500 && c.args.height === 1500))
          assert.equal((await state()).width, 2500)
          await page.evaluate(() => window.fixture.handle.setSize(10000, 10000))
          await page.waitForFunction(() => window.fixture.calls.some(c => c.command === 'sync_desktop_widget_size' && c.args.width === 7680 && c.args.height === 4320))
          assert.deepEqual([(await state()).width, (await state()).height], [7680, 4320])
          // Native resize payloads are physical pixels; content excludes chrome.
          await page.evaluate(() => window.fixture.emit('tauri://resize', { width: 3600, height: 2460 }))
          await page.waitForFunction(() => window.fixture.store.getState().floatWidgets[0].width === 1800)
          assert.equal((await state()).height, 1200)
          await page.getByRole('button', { name: 'Return widget to page' }).click()
          assert.ok((await state()).calls.some(c => c.command === 'return_extension_widget'))
        } else {
          await page.evaluate(async () => {
            const {fixture:f}=window;f.handle.setSize(10000,10000);
            await f.api.publishDesktopFloatingWidgetCatalog([]);
            await f.api.resizeDesktopFloatingWidget(f.handle.widgetId,2500,1500,false);
            await f.api.syncDesktopFloatingWidgetSize(f.handle.widgetId,2500,1500);
            await f.api.returnDesktopFloatingWidgetToPage(f.handle.widgetId);
          })
          const saved = await state()
          assert.ok(saved.width <= width && saved.height <= 900, 'In-page widgets retain viewport limits')
          assert.deepEqual(saved.calls, [], 'Browser and mobile hosts issue no desktop commands')
        }
        await page.evaluate(() => window.fixture.unmount())
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${engine} ${mode} ${width}px: placement, sizing, controls and teardown passed without browser errors`)
      }
    } finally { await runtime.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
