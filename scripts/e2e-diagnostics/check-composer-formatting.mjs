// Real composer/settings JSX with controlled API boundaries; no account data.
// Run: node scripts/e2e-diagnostics/check-composer-formatting.mjs [chromium firefox webkit]
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = await readFile(new URL('../../frontend/src/components/modals/SettingsModal.tsx', import.meta.url), 'utf8')
const start = '      <Toggle.Checkbox\n        checked={showComposerFormattingBar}'
assert.equal(source.split(start).length, 2)
const section = source.slice(source.indexOf(start), source.indexOf('/>', source.indexOf(start)) + 2)
const stubs = {
  '@/store': `import {create} from 'zustand';
    const state={activeChatId:'fixture',saveDraftInput:true,showComposerFormattingBar:false,
      activeProfileId:null,activePersonaId:null,activeCharacterId:null,activeGroupCharacterId:null,activeChatMetadata:{},
      inputBarEnterToSend:{desktop:true,mobile:false},voiceSettings:{},regenFeedback:{},councilSettings:{toolsSettings:{}},
      loomRegistry:{},characterPersonaBindings:{},personaTagBindings:{},expressionDisplay:{},defaultImpersonationMode:'prompts',
      getActivePresetForGeneration:()=>null,setActiveChatMetadata(){},setActivePersona(){},setActiveProfile(){},
      setMentionQueue(){},isMyTurn:()=>true};
    for(const field of ['chatHeads','profiles','guidedGenerations','quickReplySets','personas','recentPersonaIds','messages',
      'groupCharacterIds','mutedCharacterIds','characters','extensions'])state[field]=[];
    export const useStore=create(()=>({...state,setSetting(key,value){useStore.setState({[key]:value})}}));
    window.fixtureStore=useStore;`,
  '@/api/client': `export const BASE_URL='/api/v1';export class ApiError extends Error{};export class RequestTimeoutError extends Error{};
    export const get=async()=>({}),post=get,put=get,patch=get,del=get,upload=get,uploadRaw=get,uploadWithProgress=get;
    export const getBlob=async()=>new Blob(),postBlob=getBlob;`,
  '@/api/auth': 'export const authClient={};',
  '@/ws/client': 'export const wsClient={on:()=>()=>{},send(){}};',
  '@/ws/relayClient': 'export const sendRoomAction=()=>{};',
  '@/lib/chatAppearance': 'export const applyChatAppearance=()=>()=>{};',
  '@/lib/spindle/use-spindle-component-override': `import {createElement} from 'react';export const useSpindleComponentOverride=(_name,component,props)=>createElement(component,props);`,
  '@/hooks/useDeviceFrameRadius': 'export const useDeviceFrameRadius=()=>0;',
  '@/lib/notificationAudio': 'export const unlockNotificationAudio=()=>{};',
  '@/lib/ttsAudio': 'export const unlockTTSAudio=()=>{};',
  '@/lib/whistle/client': 'export const whistleClient={getState:()=>({})};',
  '@/components/quick-toolbar/useQuickToolbarActions': 'export const useQuickToolbarActions=()=>({actionById:new Map()});',
  './InputAreaCustomizeModal': `export default ()=>null;
    const order=['home','regen','continue','persona','tools','extras'];
    export const useComposerActionBar=()=>({order,isVisible:()=>true,reorder(){}});
    export const fromComposerExtraId=()=>null,isComposerActionId=id=>order.includes(id),runComposerSelectMessages=()=>{};`,
  './chatDockerActionCatalog': 'export const registerChatDockerActionOwners=()=>()=>{};',
  './AuthorsNotePanel': 'export default ()=>null;',
  './ReasoningBlock': 'export default ()=>null;',
  './InputBarExtensionActions': 'export default ()=>null;',
  '@/components/shared/PromptVariablesModal': 'export const PromptVariablesModal=()=>null;',
  '@/i18n': `import i18n from 'i18next';import {initReactI18next} from 'react-i18next';
    import chat from './src/i18n/locales/en/chat.json';import settings from './src/i18n/locales/en/settings.json';
    i18n.use(initReactI18next).init({lng:'en',resources:{en:{chat,settings}},initImmediate:false});export default i18n;`,
}
const bundle = await build({
  absWorkingDir:root,outfile:'composer-fixture.js',bundle:true,write:false,format:'iife',jsx:'automatic',
  stdin:{resolveDir:root+'/frontend',loader:'tsx',contents:`
    import {createRoot} from 'react-dom/client';import {useState} from 'react';import {MemoryRouter} from 'react-router';
    import {useTranslation} from 'react-i18next';import '@/i18n';import {useStore} from '@/store';
    import InputArea from '@/components/chat/InputArea';import {Toggle} from '@/components/shared/Toggle';
    import '@/theme/reset.css';import '@/theme/variables.css';
    import {generateThemeVariables} from '@/theme/engine';import {DEFAULT_THEME} from '@/theme/presets';
    window.applyFixtureTheme=(mode,glass,accent)=>{
      const vars=generateThemeVariables({...DEFAULT_THEME,enableGlass:glass,accent:accent||DEFAULT_THEME.accent},mode);
      for(const [key,value] of Object.entries(vars))document.documentElement.style.setProperty(key,value);
      document.documentElement.toggleAttribute('data-glass',glass);
    };
    function Controls(){const {t}=useTranslation('settings');
      const showComposerFormattingBar=useStore(s=>s.showComposerFormattingBar);const setSetting=useStore(s=>s.setSetting);
      return <aside aria-label="Input settings">${section}</aside>}
    function Fixture(){const [mounted,setMounted]=useState(true);return <MemoryRouter>
      <main><Controls/><button id="remount" onClick={()=>setMounted(!mounted)}>Toggle composer</button>
      <article><b>Assistant</b><p>A quiet scene unfolds. Use the optional formatting bar to shape your next message.</p></article>
      {mounted&&<InputArea chatId="fixture"/>}</main></MemoryRouter>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `},
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}','import.meta.url':'"http://fixture.test/unused.js"'},
  plugins:[{name:'fixture-boundaries',setup(builder){
    builder.onResolve({filter:/.*/},args=>Object.hasOwn(stubs,args.path)?{path:args.path,namespace:'stub'}:undefined)
    builder.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root+'/frontend'}))
    builder.onResolve({filter:/\?worker/},args=>({path:args.path,namespace:'unused-worker'}))
    builder.onLoad({filter:/.*/,namespace:'unused-worker'},()=>({contents:'export default class {}',loader:'js'}))
  }}],
})
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text
const css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html')
  res.end(req.url==='/fixture.js'?js:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
    body{background:var(--lumiverse-bg);color:var(--lumiverse-text);font-family:Arial}
    main{position:relative;height:100%;width:100%;max-width:800px;margin:auto}aside{padding:16px}#remount{margin:12px}
    article{margin:12px;padding:18px;border:1px solid var(--lumiverse-border);border-radius:12px;line-height:1.6}
    </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`
const output=join(tmpdir(),'lumiverse-composer-formatting')
await mkdir(output,{recursive:true})
const formats=[['Bold','**','**'],['Italic','*','*'],['Underline','<u>','</u>'],['Quotation marks','"','"'],['Single quotation marks',"'","'"],['Parentheses','(',')']]
const scenarios=[
  {name:'desktop',width:1440,height:900,ui:1,font:1,dpr:1},
  {name:'small-ui',width:768,height:900,ui:0.7,font:0.85,dpr:2},
  {name:'phone',width:390,height:844,ui:1,font:1,dpr:3,touch:true},
  {name:'phone-large',width:320,height:740,ui:1.5,font:2,dpr:2,touch:true},
  {name:'phone-small-ui',width:320,height:740,ui:0.7,font:1.6,dpr:3,touch:true},
  {name:'large-desktop',width:1440,height:1000,ui:2,font:2,dpr:2},
  {name:'narrow-pane',width:390,height:844,ui:1,font:1.5,dpr:2,touch:true,pane:230},
]
try{
  for(const name of process.argv.slice(2).length?process.argv.slice(2):['chromium','firefox','webkit']){
    const launched=await launchTestBrowser(name)
    try{
      for(const scenario of scenarios.filter(s=>!process.env.FORMATTING_SCENARIO||s.name===process.env.FORMATTING_SCENARIO)){
        const context=await launched.browser.newContext({viewport:{width:scenario.width,height:scenario.height},deviceScaleFactor:scenario.dpr,hasTouch:!!scenario.touch})
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)})
        try{
          await page.goto(url)
          await page.evaluate(({ui,font,pane})=>{
            document.documentElement.style.setProperty('--lumiverse-ui-scale',ui)
            document.documentElement.style.setProperty('--lumiverse-font-scale',font)
            if(pane)document.querySelector('main').style.width=pane+'px'
          },scenario)
          const bar=page.getByRole('group',{name:'Message formatting'})
          assert.equal(await bar.count(),0,'off by default')
          await page.getByRole('checkbox',{name:/^Formatting bar/}).check()
          await bar.waitFor()
          // Use the real theme engine, including custom hues and glass settings.
          if(scenario.name==='desktop'){
            const surfaces=[]
            for(const mode of ['light','dark'])for(const glass of [false,true])for(const h of [38,152,263]){
              const surface=await page.evaluate(({mode,glass,h})=>{
                window.applyFixtureTheme(mode,glass,{h,s:60,l:60});
                const el=document.querySelector('[data-composer-formatting]');
                const actual=getComputedStyle(el);
                const expected=document.createElement('div');
                expected.style.background=glass?'color-mix(in srgb, var(--lcs-glass-bg) 78%, var(--lumiverse-bg-elevated) 22%)':'var(--lumiverse-bg-elevated)';
                document.body.append(expected);
                const expectedColor=getComputedStyle(expected).backgroundColor;
                expected.remove();
                return {color:actual.backgroundColor,expected:expectedColor,filter:actual.backdropFilter};
              },{mode,glass,h})
              assert.equal(surface.color,surface.expected,`${mode}/${glass}/${h} follows the generated surface`)
              assert.equal(surface.filter==='none',!glass,`${mode}/${glass}/${h} follows glass mode`)
              surfaces.push(surface.color)
            }
            assert.ok(new Set(surfaces).size>=6,'theme mode and custom accents change the background')
            await page.evaluate(()=>window.applyFixtureTheme('dark',false))
          }
          const input=page.getByRole('textbox',{name:'Message',exact:true})
          for(const [label,open,close] of formats){
            await input.fill('Before after')
            await input.evaluate(el=>el.setSelectionRange(7,7))
            const button=bar.getByRole('button',{name:label,exact:true})
            if(scenario.touch)await button.tap();else await button.click()
            await page.waitForFunction(expected=>document.querySelector('textarea[name="chat-message"]').value===expected,'Before '+open+close+'after')
            assert.equal(await input.inputValue(),'Before '+open+close+'after',`${name}/${scenario.name}/${label} caret insertion`)
            assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd,document.activeElement===el]),[7+open.length,7+open.length,true])
            await input.pressSequentially('hello')
            assert.equal(await input.inputValue(),'Before '+open+'hello'+close+'after')
            await input.fill('Before hello after')
            await input.evaluate(el=>el.setSelectionRange(7,12,'backward'))
            if(scenario.touch)await button.tap();else await button.click()
            await page.waitForFunction(expected=>document.querySelector('textarea[name="chat-message"]').value===expected,'Before '+open+'hello'+close+' after')
            assert.equal(await input.inputValue(),'Before '+open+'hello'+close+' after')
            assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd,el.selectionDirection]),[7+open.length,12+open.length,'backward'])
            const rect=await button.boundingBox()
            const min=scenario.touch?44:32
            assert.ok(rect.width>=min-0.6&&rect.height>=min-0.6,`tap target ${JSON.stringify(rect)}`)
          }
          // Native undo must restore the draft; redo restores the formatting.
          await input.fill('undo this')
          // Start with a recovered draft so WebKit cannot coalesce fixture fills
          // and earlier insertText commands into the same native undo group.
          await page.locator('#remount').evaluate(el=>el.click());await page.locator('#remount').evaluate(el=>el.click())
          await input.evaluate(el=>el.setSelectionRange(5,9))
          await bar.getByRole('button',{name:'Bold',exact:true}).click()
          await input.press(process.platform==='darwin'?'Meta+z':'Control+z')
          assert.equal(await input.inputValue(),'undo this',`${name} native undo`)
          await input.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z')
          assert.equal(await input.inputValue(),'undo **this**',`${name} native redo`)
          // IME events must not have their still-composing text wrapped.
          await input.dispatchEvent('compositionstart',{data:'あ'})
          await bar.getByRole('button',{name:'Bold',exact:true}).click()
          assert.equal(await input.inputValue(),'undo **this**')
          await input.dispatchEvent('compositionend',{data:'あ'})
          // Keyboard-only access and focus return.
          const italic=bar.getByRole('button',{name:'Italic',exact:true})
          await italic.focus();await italic.press('Enter')
          assert.equal(await input.evaluate(el=>document.activeElement===el),true)
          const saved=await input.inputValue()
          await page.locator('#remount').evaluate(el=>el.click());await page.locator('#remount').evaluate(el=>el.click())
          assert.equal(await input.inputValue(),saved,'persisted formatted draft')
          const geometry=await bar.evaluate(el=>{
            const b=el.getBoundingClientRect(),c=el.closest('[data-component="InputArea"]').getBoundingClientRect()
            return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,parentLeft:c.left,parentRight:c.right,parentTop:c.top,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}
          })
          assert.ok(geometry.left>=geometry.parentLeft-1&&geometry.right<=geometry.parentRight+1,JSON.stringify(geometry))
          assert.ok(geometry.top>=0&&geometry.bottom<geometry.parentTop,JSON.stringify(geometry))
          assert.ok(Math.abs((geometry.left+geometry.right)/2-(geometry.parentLeft+geometry.parentRight)/2)<1,'pill centered above composer')
          const zone=await page.locator('main').evaluate(el=>parseFloat(el.style.getPropertyValue('--lcs-composer-safe-zone')))
          const composerHeight=await page.locator('[data-component="InputArea"]').evaluate(el=>el.offsetHeight)
          assert.ok(zone>composerHeight,'floating pill is included in the chat safe zone')
          const send=await page.locator('button').filter({has:page.locator('svg.lucide-send')}).boundingBox()
          assert.ok(send&&send.x>=geometry.parentLeft-1&&send.x+send.width<=geometry.parentRight+1,'send button stays in the composer')
          if(geometry.scrollWidth>geometry.clientWidth+2){
            await bar.getByRole('button',{name:'Parentheses',exact:true}).focus()
            await page.waitForFunction(()=>{const el=document.querySelector('[aria-label="Message formatting"]');return el.scrollLeft>0});
          }
          if(scenario.name==='phone'||scenario.name==='phone-large'){
            await input.fill('The scene is **quiet**, and I pause to listen.')
            await page.screenshot({path:join(output,`${name}-${scenario.name}.png`),scale:'css'});
            const composer=await page.locator('[data-component="InputArea"]').boundingBox();const floating=await bar.boundingBox();
            await page.screenshot({path:join(output,`${name}-${scenario.name}-composer.png`),scale:'css',clip:{x:composer.x,y:floating.y,width:composer.width,height:composer.y+composer.height-floating.y}})
          }
          await page.getByRole('checkbox',{name:/^Formatting bar/}).evaluate(el=>el.click())
          assert.equal(await bar.count(),0)
          assert.deepEqual(errors,[])
          console.log(`PASS ${name}/${scenario.name}: insertion, selection, focus, typing, undo/redo, IME, persistence, targets, containment`)
        }finally{await context.close()}
      }
    }finally{await launched.close()}
  }
  console.log(`Screenshots: ${output}`)
}finally{await new Promise(resolve=>server.close(resolve))}
