// Controlled fixtures, real settings JSX and MessageContent. No personal chat data.
// Run: node scripts/e2e-diagnostics/check-long-message-collapse.mjs [chromium webkit]
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = await readFile(new URL('../../frontend/src/components/modals/SettingsModal.tsx', import.meta.url), 'utf8')
const start = '      <h3 id={sectionAnchorId(\'display\', \'longMessages\')}'
const end = '      <h3 id={sectionAnchorId(\'display\', \'modalWidth\')}'
assert.equal(source.split(start).length, 2, 'unique long-message settings anchor')
assert.equal(source.split(end).length, 2, 'unique next-section anchor')
assert.ok(source.indexOf(end) > source.indexOf(start))
// Mount the exact production section without unrelated settings/network surfaces.
const section = source.slice(source.indexOf(start), source.indexOf(end))
const bundle = await build({
  absWorkingDir: root, outfile: 'long-message-fixture.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
  stdin: { resolveDir: root + '/frontend', loader: 'tsx', contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {useTranslation} from 'react-i18next'; import '@/i18n'; import {useStore} from '@/store';
    import MessageContent from '@/components/chat/MessageContent';
    import {Toggle} from '@/components/shared/Toggle'; import NumericInput from '@/components/shared/NumericInput';
    import clsx from 'clsx'; import styles from '@/components/modals/SettingsModal.module.css';
    import '@/theme/reset.css';
    const sectionAnchorId = (tab, section) => tab + '-' + section;
    const sectionTitleClass = styles.sectionTitle;
    useStore.setState({activeChatId:'fixture',activeCharacterId:null,activeGroupCharacterId:null,characters:[],
      groupCharacterIds:[],isGroupChat:false,personas:[],messages:[],regexScripts:[],oocEnabled:false,lumiaOOCStyle:'card',
      longMessageCollapseEnabled:true,longMessageCollapseUserMessages:false,longMessageCollapsePreset:'compact',
      longMessageCollapseCustomHeight:500,longMessageCollapseDepth:0,expandedLongMessageKeys:[],
      setSetting(key,value){useStore.setState({[key]:value})},
      setLongMessageExpanded(chat,id,expanded){const key=chat+':'+id;useStore.setState(s=>({expandedLongMessageKeys:expanded?[...s.expandedLongMessageKeys,key]:s.expandedLongMessageKeys.filter(k=>k!==key)}))}
    });
    function Controls(){
      const {t}=useTranslation('settings');
      const longMessageCollapseEnabled=useStore(s=>s.longMessageCollapseEnabled);
      const longMessageCollapseUserMessages=useStore(s=>s.longMessageCollapseUserMessages);
      const longMessageCollapsePreset=useStore(s=>s.longMessageCollapsePreset);
      const longMessageCollapseCustomHeight=useStore(s=>s.longMessageCollapseCustomHeight);
      const longMessageCollapseDepth=useStore(s=>s.longMessageCollapseDepth);
      const setSetting=useStore(s=>s.setSetting);
      return <>${section}</>
    }
    function Fixture(){const [open,setOpen]=useState(true);const [mounted,setMounted]=useState(true);
      return <main style={{padding:'calc(var(--app-interactive-safe-top) + 12px) 12px 24px',maxWidth:800,margin:'auto',height:'var(--app-scaled-viewport-height)',overflow:'auto'}}>
        <button onClick={()=>setOpen(!open)}>{open?'Close settings':'Open settings'}</button>
        {open&&<section aria-label="Long message settings"><Controls/></section>}
        <button onClick={()=>setMounted(!mounted)}>Toggle messages</button>
        {mounted&&<>{[false,true].map(isUser=><article key={String(isUser)} aria-label={isUser?'User message':'Assistant message'}>
          <MessageContent content={Array.from({length:40},(_,i)=>'Paragraph '+i+' of this long message.').join('\\n\\n')}
            isUser={isUser} userName="Reader" chatId="fixture" messageId={isUser?'user':'assistant'}/>
        </article>)}</>}
      </main>
    }createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'import.meta.url': '"http://fixture.test/unused-worker.js"' },
  plugins: [{ name: 'controlled-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@\/store$/ }, args => ({ path: args.path, namespace: 'fixture-store' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture-store' }, () => ({ contents: 'import {create} from "zustand";export const useStore=create(()=>({}));', loader: 'js', resolveDir: root + '/frontend' }))
    builder.onResolve({ filter: /^@\/i18n$/ }, args => ({ path: args.path, namespace: 'fixture-i18n' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture-i18n' }, () => ({ contents: `import i18n from 'i18next';import {initReactI18next} from 'react-i18next';import settings from './src/i18n/locales/en/settings.json';import chat from './src/i18n/locales/en/chat.json';i18n.use(initReactI18next).init({lng:'en',resources:{en:{settings,chat}},initImmediate:false});export default i18n;export const changeUiLanguage=async()=>{};`, loader: 'js', resolveDir: root + '/frontend' }))
    builder.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'unused-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default "unused-fixture-worker"', loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).text
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/fixture.js' ? js : `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}
    :root{--lumiverse-text:#eee;--lumiverse-text-muted:#aaa;--lumiverse-bg:#19181f;--lumiverse-border:#444;--lumiverse-primary:#b4a6ff}
    body{background:var(--lumiverse-bg);color:var(--lumiverse-text);font-family:Arial}article{margin-top:20px}button{color:inherit}
    </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit']) {
    const launched = await launchTestBrowser(name)
    try {
      for (const mobile of [false, true]) {
        const context = await launched.browser.newContext(mobile ? { ...playwright.devices['iPhone 13'] } : { viewport: { width: 1280, height: 900 } })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        // Headless engines report zero env() insets; model a notched shell through its canonical variable.
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        if (mobile) await page.evaluate(() => document.documentElement.style.setProperty('--app-interactive-safe-top', '47px'))
        const user = page.getByRole('article', { name: 'User message', exact: true })
        const assistant = page.getByRole('article', { name: 'Assistant message', exact: true })
        const more = user.getByRole('button', { name: 'Read more', exact: true })
        await assistant.getByRole('button', { name: 'Read more', exact: true }).waitFor()
        assert.equal(await more.count(), 0, 'user message remains fully expanded by default')
        const checkbox = page.getByRole('checkbox', { name: 'Also collapse user messages' })
        await checkbox.focus(); await page.keyboard.press('Space')
        await more.waitFor()
        await page.screenshot({ path: join(tmpdir(), `long-message-${name}-${mobile ? 'mobile' : 'desktop'}.png`) })
        assert.equal(await more.getAttribute('aria-expanded'), 'false')
        const bodyId = await more.getAttribute('aria-controls')
        assert.equal(await page.locator('#' + bodyId).evaluate(el => el.style.maxHeight), '300px')
        await more.focus(); await page.keyboard.press('Enter')
        const less = user.getByRole('button', { name: 'Show less', exact: true })
        await less.waitFor(); assert.equal(await less.getAttribute('aria-expanded'), 'true')
        await page.getByRole('button', { name: 'Toggle messages', exact: true }).click()
        await page.getByRole('button', { name: 'Toggle messages', exact: true }).click()
        await less.waitFor()
        await less.click(); await more.waitFor()
        await page.getByRole('button', { name: 'Close settings', exact: true }).click()
        await page.getByRole('button', { name: 'Open settings', exact: true }).click()
        assert.equal(await checkbox.isChecked(), true)
        await checkbox.uncheck()
        assert.equal(await more.count(), 0)
        await assistant.getByRole('button', { name: 'Read more', exact: true }).waitFor()
        await page.getByRole('checkbox', { name: 'Collapse long messages', exact: false }).first().uncheck()
        assert.equal(await checkbox.count(), 0)
        assert.equal(await assistant.getByRole('button', { name: 'Read more', exact: true }).count(), 0)
        await page.getByRole('button', { name: 'Close settings', exact: true }).scrollIntoViewIfNeeded()
        const safeTop = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-interactive-safe-top')) || 0)
        assert.ok((await page.getByRole('button', { name: 'Close settings', exact: true }).boundingBox()).y >= safeTop)
        if (mobile) assert.equal(safeTop, 47)

        assert.deepEqual(errors, [])
        console.log(`${name} ${mobile ? 'iPhone 13' : 'desktop'}: default, opt-in, keyboard/mouse, ARIA, remount, close/reopen and disable passed`)
        await context.close()
      }
    } finally { await launched.close() }
  }
} finally { server.close() }
