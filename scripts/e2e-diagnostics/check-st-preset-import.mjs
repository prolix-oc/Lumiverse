// Real Loom import, validation, editor and drag/drop with controlled persistence/profile state.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hookSource = `
  import {useSyncExternalStore} from 'react';
  import {presetsApi} from '@/api/presets';
  import {marshalImportedPresetForEditor,unmarshalPresetForEditor} from '@/lib/loom/preset-validation';
  import {marshalUpdate,exportToSTPreset,createPortableLoomPresetExport,toggleBlockWithCategoryRules,toggleCategoryWithChildren} from '@/lib/loom/service';
  let preset=null;
  const listeners=new Set();
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
  const publish=p=>{preset=p;for(const listener of listeners)listener()};
  let pending=Promise.resolve();
  const save=p=>{publish(p);pending=pending.then(()=>presetsApi.update(p.id,marshalUpdate(p)));return pending};
  const importPayload=async(payload,name)=>{const row=await presetsApi.create(marshalImportedPresetForEditor(payload,name));publish(unmarshalPresetForEditor(row));return row};
  const noop=()=>{};
  window.stImportCheck={
    get:()=>preset,flush:()=>pending,
    reload:async()=>publish(unmarshalPresetForEditor(await presetsApi.get(preset.id))),
    portable:()=>createPortableLoomPresetExport(preset),
    stRoundTrip:()=>marshalImportedPresetForEditor(exportToSTPreset(preset),'Round trip'),
    load:importPayload,
  };
  export function useLoomBuilder(){
    const current=useSyncExternalStore(subscribe,()=>preset);
    return {
      registry:current?{[current.id]:{name:current.name,blockCount:current.blocks.length}}:{},
      activePreset:current,activePresetId:current?.id,isLoading:false,availableMacros:[],SAMPLER_PARAMS:[],
      connectionProfile:null,refreshMacros:noop,refreshConnectionProfile:noop,
      importFromST:importPayload,importFromFile:importPayload,
      saveBlocks:blocks=>save({...preset,blocks}),
      updateBlock:(id,updates)=>save({...preset,blocks:preset.blocks.map(b=>b.id===id?{...b,...updates}:b)}),
      toggleBlock:id=>save({...preset,blocks:toggleBlockWithCategoryRules(preset.blocks,id)}),
      toggleCategoryChildren:id=>save({...preset,blocks:toggleCategoryWithChildren(preset.blocks,id)}),
      updatePresetDraft:noop,flushPresetDraft:()=>pending,applyRuntimeBlockProfile:noop,
    };
  }
`
const profileSource = `
  const state={isResolved:false,activeSource:'none',activeBinding:null,defaults:null,isLoading:false};
  export const usePresetProfiles=()=>state;
`
const i18nSource = `
  import i18n from 'i18next';import {initReactI18next} from 'react-i18next';
  import panels from '@/i18n/locales/en/panels.json';import common from '@/i18n/locales/en/common.json';
  i18n.use(initReactI18next).init({lng:'en',resources:{en:{panels,common}},initImmediate:false});
  export default i18n;
`
const virtual = { '@\/hooks\/useLoomBuilder': hookSource, '@\/hooks\/usePresetProfiles': profileSource, '@\/i18n': i18nSource }
const bundle = await build({
  absWorkingDir: root, stdin: { resolveDir: root + '/frontend', loader: 'tsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import './src/theme/global.css';import LoomBuilder from './src/components/panels/LoomBuilder';
    createRoot(document.getElementById('root')).render(<LoomBuilder/>);
  ` }, outfile: 'fixture.js', bundle: true, write: false, format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'controlled-preset-state', setup(builder) {
    builder.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'unused-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default class UnusedWorker {}', loader: 'js' }))
    for (const [path, contents] of Object.entries(virtual)) {
      builder.onResolve({ filter: new RegExp('^' + path + '$') }, () => ({ path, namespace: 'fixture' }))
      builder.onLoad({ filter: new RegExp('^' + path + '$'), namespace: 'fixture' }, () => ({ contents, loader: 'ts', resolveDir: root + '/frontend' }))
    }
  } }],
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
const rows = new Map()
let nextId = 0
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/v1/presets')) {
    res.setHeader('Content-Type', 'application/json')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const id = req.url.split('/')[4]
    if (req.method === 'POST') {
      const row = { ...input, id: String(++nextId), created_at: 1, updated_at: 1 }
      rows.set(row.id, row); res.end(JSON.stringify(row))
    } else if (req.method === 'PUT') {
      const row = { ...rows.get(id), ...input }; rows.set(id, row); res.end(JSON.stringify(row))
    } else res.end(JSON.stringify(rows.get(id)))
    return
  }
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/fixture.js' ? js : `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0}#root{height:100dvh}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const source = {
  prompts: [
    { identifier: 'root-drop:0', name: 'Root-like identifier', content: 'First content' },
    { identifier: ' padded ', name: '<img src=x onerror="window.injected=true">', content: 'Literal content' },
    { identifier: 'custom-prompt', name: 'Editable prompt', content: 'Editable content' },
    { identifier: 'dup', name: 'Duplicate one', content: 'One' },
    { identifier: 'dup', name: 'Duplicate two', content: 'Two' },
    { name: 'Missing identifier', content: 'Missing' },
    { identifier: '__proto__', name: 'Reserved identifier', content: 'Reserved content' },
  ],
  extensions: { toolkit: { ids: ['root-drop:0', ' padded ', 'custom-prompt'] } },
}
const rowFor = (page, name) => page.locator('[data-tooltip]').filter({ has: page.getByText(name, { exact: true }) }).locator('..')
async function drag(page, handle, target, armCategory = false) {
  await handle.scrollIntoViewIfNeeded()
  const from = await handle.boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 3 })
  await page.locator('[aria-pressed="true"]').waitFor()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const to = await target.boundingBox()
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (armCategory) await page.getByLabel('Drop at bottom of category', { exact: true }).waitFor().catch(async error => {
    console.error(JSON.stringify({ status: await page.locator('[role="status"]').allTextContents(), slots: await page.getByLabel('Drop at root level', { exact: true }).count(), target: to }))
    throw error
  })
  await page.mouse.up()
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))
  })
}
try {
  for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
        page.setDefaultTimeout(10000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.locator('input[type=file]').setInputFiles({ name: 'ST.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) })
        await page.getByText('Root-like identifier', { exact: true }).waitFor()
        const initial = await page.evaluate(() => window.stImportCheck.get())
        assert.equal(initial.blocks.length, 8)
        assert.equal(new Set(initial.blocks.map(block => block.id)).size, 8)
        assert.ok(initial.blocks.every(block => !Object.hasOwn(Object.prototype, block.id)))
        assert.ok(initial.blocks.some(block => block.name === 'Reserved identifier' && block.content === 'Reserved content'))
        for (const id of source.extensions.toolkit.ids) assert.ok(initial.blocks.some(block => block.id === id))
        assert.deepEqual(initial.passthroughMetadata.toolkit, source.extensions.toolkit)
        assert.equal(await page.evaluate(() => window.injected), undefined)
        assert.equal(await page.locator('[data-tooltip] img').count(), 0)

        await rowFor(page, 'Editable prompt').getByRole('button', { name: 'Edit', exact: true }).click()
        await page.locator('textarea').first().fill('Edited content')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.evaluate(() => window.stImportCheck.flush())
        await page.evaluate(() => window.stImportCheck.reload())
        assert.equal(await page.evaluate(() => window.stImportCheck.get().blocks.find(block => block.id === 'custom-prompt').content), 'Edited content')

        // The string id must remain a normal sortable row while numeric root slots coexist.
        await drag(page, rowFor(page, 'Editable prompt').getByRole('button', { name: 'Drag to reorder', exact: true }), rowFor(page, 'Root-like identifier'))
        await page.waitForFunction(() => window.stImportCheck.get().blocks[0].id === 'custom-prompt')
        await drag(page, rowFor(page, 'Duplicate one').getByRole('button', { name: 'Drag to reorder', exact: true }), rowFor(page, 'Root-like identifier'))
        await page.waitForFunction(() => window.stImportCheck.get().blocks[1].name === 'Duplicate one')
        const handle = rowFor(page, 'Root-like identifier').getByRole('button', { name: 'Drag to reorder', exact: true })
        const beforeKeyboard = await page.evaluate(() => window.stImportCheck.get().blocks.map(block => block.id))
        await handle.focus(); await page.keyboard.press('Space')
        await page.locator('[aria-pressed="true"]').waitFor()
        await page.keyboard.press('ArrowDown')
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.keyboard.press('Space')
        await page.waitForFunction(before => JSON.stringify(window.stImportCheck.get().blocks.map(block => block.id)) !== JSON.stringify(before), beforeKeyboard)
        await page.evaluate(() => window.stImportCheck.flush())
        const roundTrip = await page.evaluate(() => window.stImportCheck.stRoundTrip())
        assert.equal(roundTrip.prompt_order.length, 8)
        assert.equal(new Set(roundTrip.prompt_order.map(block => block.id)).size, 8)
        assert.ok(roundTrip.prompt_order.some(block => block.id === 'root-drop:0'))
        await page.evaluate(async () => { await window.stImportCheck.load(window.stImportCheck.portable(), 'Portable'); await window.stImportCheck.reload() })
        assert.equal(await page.evaluate(() => window.stImportCheck.get().blocks.length), 8)

        await page.evaluate(() => window.stImportCheck.load({ prompts: [
          { identifier: 'root-drop:0', name: '━━━━ Category A', content: '' },
          { identifier: 'child-a', name: 'Child A', content: 'A' },
          { identifier: 'cat-b', name: '━━━━ Category B', content: '' },
          { identifier: 'child-b', name: 'Child B', content: 'B' },
        ] }, 'Categories'))
        await page.getByRole('button', { name: 'Expand all', exact: true }).click()
        await page.getByText('Child A', { exact: true }).waitFor()
        await drag(page, rowFor(page, 'Child A').getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByLabel('Drop at root level', { exact: true }).first())
        await page.waitForFunction(() => window.stImportCheck.get().blocks[0].id === 'child-a' && window.stImportCheck.get().blocks[0].group === null).catch(async error => {
          console.error(JSON.stringify({ blocks: await page.evaluate(() => window.stImportCheck.get().blocks), status: await page.locator('[role="status"]').allTextContents() }))
          throw error
        })
        // After the root row and category A, the third slot appends to category A.
        await drag(page, rowFor(page, 'Child A').getByRole('button', { name: 'Drag to reorder', exact: true }), page.getByLabel('Drop at root level', { exact: true }).nth(2), true)
        await page.waitForFunction(() => window.stImportCheck.get().blocks.find(block => block.id === 'child-a').group === 'root-drop:0')
        await drag(page, page.getByRole('button', { name: 'Drag to reorder (moves all items in this category)', exact: true }).nth(1), page.getByLabel('Drop at root level', { exact: true }).first())
        await page.waitForFunction(() => window.stImportCheck.get().blocks[0].id === 'cat-b' && window.stImportCheck.get().blocks[1].id === 'child-b')
        await page.evaluate(() => window.stImportCheck.flush())
        assert.deepEqual(errors, [])
        console.log(`${engine} ${runtime.browser.version()} ${width}px: import, identities, edit/save/reload, mouse/keyboard reorder, category detach/append, exports and literal rendering passed`)
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
