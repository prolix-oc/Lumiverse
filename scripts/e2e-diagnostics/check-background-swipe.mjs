// Controlled native swipe/store integration. No backend, personal chats or keys.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('../../frontend/tests/background-swipe.fixture.tsx', import.meta.url)).replaceAll('\\', '/')
const stubs = {
  '@/store': `export { useFixtureStore as useStore } from ${JSON.stringify(fixture)}`,
  '@/api/settings': 'export const settingsApi = {put:async()=>{}}',
  '@/api/generate': `import {start} from ${JSON.stringify(fixture)}; export const generateApi={start}`,
  '@/api/chats': `import {swipe} from ${JSON.stringify(fixture)}; export const messagesApi={swipe}`,
  '@/i18n': 'export default {t:key=>key}',
  'react-i18next': `export const useTranslation=()=>({t:key=>({'swipe.next':'Next swipe','swipe.previous':'Previous swipe','swipe.live':'Generating swipe','swipe.ready':'New swipe ready'}[key]||key)})`,
}
const bundle = await build({absWorkingDir:root, entryPoints:[fixture], outfile:'background-swipe.js', bundle:true, write:false, format:'iife', jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"'}, plugins:[{name:'controlled-background-swipe',setup(build){
    build.onResolve({filter:/.*/}, args=>args.path in stubs?{path:args.path,namespace:'stub'}:undefined)
    build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'js',resolveDir:root}))
  }}]})
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text
const css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text
for(const name of (process.env.SWIPE_BROWSERS||'chromium,firefox,webkit').split(',')) {
  const launched=await launchTestBrowser(name)
  const { browser }=launched
  try {
    for(const width of [1280,390]) {
      const page=await browser.newPage({viewport:{width,height:844},hasTouch:width===390,isMobile:width===390})
      const errors=[];page.on('pageerror',error=>errors.push(error.message))
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}body{background:#181b18;color:#e9dfc3;font:16px sans-serif;margin:24px}article{min-height:180px;padding:24px;border:1px solid #aaa6;border-radius:12px}button{min-height:44px}main{max-width:700px;margin:auto}</style><div id="root"></div>`)
      await page.addScriptTag({content:js})
      const reply=page.getByRole('article',{name:'Selected reply'})
      await reply.waitFor()
      const original=await reply.innerText()
      await page.getByRole('button',{name:'Generate swipe in background',exact:true}).click()
      await page.evaluate(()=>window.backgroundSwipeFixture.token())
      assert.equal(await reply.innerText(),original)
      assert.equal(await page.getByRole('button',{name:'Generate swipe in background',exact:true}).isEnabled(),false)
      await page.evaluate(()=>window.backgroundSwipeFixture.complete())
      assert.equal(await reply.innerText(),original)
      assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).every(index=>index===0))
      await page.getByRole('button',{name:'New swipe ready',exact:true}).click()
      assert.equal(await reply.innerText(),'A newly generated response.')
      for (const modifier of ['Control','Meta']) {
        await page.evaluate(()=>window.backgroundSwipeFixture.reset())
        await page.getByRole('button',{name:'Next swipe',exact:true}).click({modifiers:[modifier]})
        await page.evaluate(()=>window.backgroundSwipeFixture.token())
        assert.equal(await reply.innerText(),original)
        await page.evaluate(()=>window.backgroundSwipeFixture.complete())
        assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).every(index=>index===0))
      }
      await page.evaluate(()=>window.backgroundSwipeFixture.reset())
      await page.getByRole('button',{name:'Next swipe',exact:true}).press('Control+Enter')
      assert.equal(await reply.innerText(),original)
      await page.evaluate(()=>window.backgroundSwipeFixture.complete())
      await page.evaluate(()=>window.backgroundSwipeFixture.reset())
      for (const modifier of ['Control','Meta']) {
        await page.getByRole('textbox',{name:'Draft message'}).press(modifier+'+ArrowRight')
        assert.equal(await page.getByRole('button',{name:'Generate swipe in background',exact:true}).isEnabled(),true, 'Editing shortcuts must remain untouched')
        await reply.press(modifier+'+ArrowLeft')
        assert.equal(await page.getByRole('button',{name:'Generate swipe in background',exact:true}).isEnabled(),true)
        await reply.press(modifier+'+ArrowRight')
        await page.evaluate(()=>window.backgroundSwipeFixture.token())
        assert.equal(await reply.innerText(),original)
        await page.evaluate(()=>window.backgroundSwipeFixture.complete())
        assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).every(index=>index===0))
        await page.evaluate(()=>window.backgroundSwipeFixture.reset())
      }
      await reply.evaluate(element=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',ctrlKey:true,repeat:true,bubbles:true,cancelable:true})))
      assert.equal(await page.getByRole('button',{name:'Generate swipe in background',exact:true}).isEnabled(),true, 'Key repeat must not queue generation')
      await reply.press('ArrowRight')
      assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).includes(1), 'Plain ArrowRight must retain normal swiping')
      await page.evaluate(()=>window.backgroundSwipeFixture.complete())
      await page.evaluate(()=>window.backgroundSwipeFixture.reset())
      let next = page.getByRole('button',{name:'Next swipe',exact:true})
      for (const cancel of ['pointerup','pointercancel','pointermove']) {
        await next.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:10,clientY:10})
        await next.dispatchEvent(cancel,{pointerType:'touch',clientX:50,clientY:50})
        await page.waitForTimeout(480)
        assert.equal(await page.getByRole('button',{name:'Generate swipe in background',exact:true}).isEnabled(),true, cancel+' cancels the hold')
      }
      await next.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:10,clientY:10})
      await page.waitForTimeout(480)
      await page.evaluate(()=>window.backgroundSwipeFixture.token())
      assert.equal(await reply.innerText(),original)
      next=page.getByRole('button',{name:'Generating swipe',exact:true})
      assert.equal(await next.evaluate(button=>button.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),false)
      await next.dispatchEvent('pointerup',{pointerType:'touch'})
      await page.evaluate(()=>window.backgroundSwipeFixture.complete())
      await page.getByRole('button',{name:'New swipe ready',exact:true}).dispatchEvent('click',{detail:1})
      assert.equal(await reply.innerText(),original, 'Release click after holding must not select the new swipe')
      assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).every(index=>index===0))
      await page.evaluate(()=>window.backgroundSwipeFixture.reset())
      await page.getByRole('button',{name:'Next swipe',exact:true}).click()
      assert.ok((await page.evaluate(()=>window.backgroundSwipeFixture.selections())).includes(1), 'Ordinary click should still select the new swipe')
      assert.deepEqual(errors,[])
      console.log(`${name} ${width}px: background generation preserves selected response; native ready/navigation pass`)
      await page.close()
    }
  } finally {await launched.close()}
}
