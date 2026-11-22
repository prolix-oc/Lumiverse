import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import CodeEditor from '../src/components/panels/custom-css/CSSEditor'
import { ModalShell } from '../src/components/shared/ModalShell'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import '../src/theme/reset.css'
import '../src/theme/global.css'

const params = new URLSearchParams(location.search)
const tsx = params.has('tsx')
const dock = params.has('dock')
const language = tsx ? javascript({ jsx: true, typescript: true }) : undefined
const initialValue = tsx
  ? 'const first = "needle";\nconst second = "needle";'
  : '.first { color: red; }\n.second { color: red; }'
const bubbled: string[] = []
let appFinds = 0
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'F3' ||
      ((event.ctrlKey || event.metaKey) && ['f', 'g', 'k', 'z'].includes(event.key.toLowerCase()))) {
    bubbled.push(event.key)
  }
  if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    appFinds++
  }
})
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
Object.assign(window, { codeEditorFixture: {
  bubbled,
  get appFinds() { return appFinds },
  get value() { return view().state.doc.toString() },
  get selection() { const { from, to } = view().state.selection.main; return { from, to } },
  select(from: number, to = from) { view().dispatch({ selection: { anchor: from, head: to } }); view().focus() },
} })
for (const [key, value] of Object.entries(generateThemeVariables(DEFAULT_THEME, 'dark'))) {
  document.documentElement.style.setProperty(key, value)
}

function Fixture() {
  const [value, setValue] = useState(initialValue)
  const [open, setOpen] = useState(true)
  const editor = <div data-editor-surface style={{ display: 'flex', height: 400, minHeight: 0 }}>
    <CodeEditor value={value} onChange={setValue} language={language} />
  </div>
  return <>
    <input aria-label="Outside editor" />
    {dock ? editor : <ModalShell isOpen={open} onClose={() => setOpen(false)} maxWidth={900}>
      {editor}
    </ModalShell>}
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
