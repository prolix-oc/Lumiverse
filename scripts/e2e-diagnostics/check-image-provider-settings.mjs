// Real generation settings UI with controlled connection data; no provider calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cases = [
  ['custom_openai', 'model', false], ['together', 'black-forest-labs/FLUX.2-dev', true],
  ['xai', 'grok-imagine-image-2.0', true], ['venice', 'venice-sd35', false],
  ['venice_compat', 'model', false], ['recraft', 'recraftv4', false], ['deepinfra', 'model', false],
  ['ideogram', 'ideogram-4-5', true], ['ideogram', 'ideogram-2a', false], ['fireworks', 'model', false],
  ['stability', 'core', false], ['stability', 'ultra', true], ['bfl', 'flux-kontext-pro', true],
  ['fal', 'fal-ai/flux/dev', false], ['fal', 'fal-ai/flux/dev/image-to-image', true],
  ['replicate', 'model', false], ['leonardo', 'model', false], ['runware', 'runware:100@1', true],
  ['civitai', 'anima', false], ['civitai_chat', 'model', false], ['huggingface', 'model', false],
  ['openai', 'gpt-image-1', true], ['openrouter', 'model', true], ['sdapi', 'model', true],
]
const bundle = await build({
  absWorkingDir: root, stdin: { resolveDir: root + '/frontend', loader: 'tsx', contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import i18n from 'i18next'; import {initReactI18next} from 'react-i18next';
    import panels from './src/i18n/locales/en/panels.json';
    import ImageGenSettingsModal from './src/components/modals/ImageGenSettingsModal';
    import {imageInputMechanism} from '../src/image-gen/image-input';
    i18n.use(initReactI18next).init({lng:'en',resources:{en:{panels}},initImmediate:false});
    const cases = ${JSON.stringify(cases)};
    function App(){ const [index,setIndex]=useState(0),[params,setParams]=useState({}),[open,setOpen]=useState(true);
      const [provider,model]=cases[index]; const supported=imageInputMechanism(provider,model)!==null;
      window.selectCase=i=>{setIndex(i);setParams({});setOpen(true)};
      const updateParam=(key,value)=>setParams(p=>({...p,[key]:value}));
      return <ImageGenSettingsModal isOpen={open} onClose={()=>setOpen(false)} imageGeneration={{}}
        updateTop={()=>{}} controller={{ activeConnection:{id:provider,provider,model}, providerName:provider,
          paramGroups:{main:[],advanced:[],references:[],extra:[]},genParams:params,updateParam,
          isComfyUI:false,isNovelAIV5:false,supportsRefs:supported,supportsImg2ImgSource:supported,
          workflowConfig:null,workflowError:null,workflowLoading:false,comfyCustomControls:[],
          currentRefs:params.referenceImages||[],setCurrentRefs:refs=>updateParam('referenceImages',refs),
          onPickRefs:()=>updateParam('referenceImages',[{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=',mimeType:'image/png'}])
        }}/> }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, outfile: 'fixture.js', bundle: true, write: false, format: 'esm', jsx: 'automatic',
  define: {'process.env.NODE_ENV':'"development"', 'import.meta.env':'{}'},
})
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text
const css = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text || ''
const server = createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html')
  res.end(req.url==='/fixture.js'?js:`<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root{--lumiverse-ui-scale:1;--lumiverse-text:#eee;--lumiverse-bg:#222;--lumiverse-bg-deep:#222;--lumiverse-border:#666;--lumiverse-primary:#aaf}body{font-family:Arial}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try {
  for(const engine of ['chromium','firefox','webkit']) {
    const runtime=await launchTestBrowser(engine)
    try {
      for(const width of [1280,390]) {
        const page=await runtime.browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'})
        const errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.getByRole('dialog',{name:'Generation Settings'}).waitFor()
        for(const [index,[provider,model,supported]] of cases.entries()) {
          await page.evaluate(index=>window.selectCase(index),index)
          const nav=page.getByRole('navigation',{name:'Generation settings view'})
          await page.waitForFunction(([supported])=>!!document.querySelector('nav button') && [...document.querySelectorAll('nav button')].some(b=>b.textContent==='Sources')===supported,[supported])
          assert.equal(await nav.getByRole('button',{name:'Sources',exact:true}).count(),supported?1:0,`${provider}/${model}`)
          if(supported) {
            await nav.getByRole('button',{name:'Sources',exact:true}).click()
            const add=page.getByRole('button',{name:'Add Reference',exact:true})
            await add.click();await page.locator('img[alt="Reference 1"]').waitFor()
            await page.getByRole('button',{name:/remove$/}).click()
            assert.equal(await page.locator('img[alt="Reference 1"]').count(),0)
          }
        }
        assert.deepEqual(errors,[])
        console.log(`${engine} ${width}px: ${cases.length} provider/model settings, source add/remove and no runtime errors passed`)
        await page.close()
      }
    } finally {await runtime.close()}
  }
} finally {await new Promise(resolve=>server.close(resolve))}
