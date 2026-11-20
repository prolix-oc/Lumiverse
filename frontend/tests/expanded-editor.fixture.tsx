import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import ExpandedTextEditor from '../src/components/shared/ExpandedTextEditor'
import { ModalShell } from '../src/components/shared/ModalShell'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import { computeVisibleViewport, computeViewportKeyboardInset } from '../src/lib/viewportKeyboardInset'
import { KEYBOARD_VIEWPORT_EVENT } from '../src/lib/keyboardViewport'
import { getExpandedEditorCaretRect } from '../src/lib/expandedEditorCaret'
import { installKeyboardFocusReveal } from '../src/lib/keyboardFocusReveal'
import app from '../src/App.module.css'
import wallpaper from '../src/components/shared/WallpaperLayer.module.css'
import input from '../src/components/chat/InputArea.module.css'
import worldbook from '../src/components/modals/WorldBookEditorModal.module.css'
import entry from '../src/components/shared/WorldBookEntryEditor.module.css'
import '../src/theme/reset.css'
import '../src/theme/global.css'

void i18next.use(initReactI18next).init({ lng: 'en', resources: {}, initImmediate: false })

const initialValue = Array.from({ length: 60 }, (_, index) =>
  `${index}: {{char}} {{setvar::name::value}} <tag>**bold** *italic* \`code\`</tag>\t` +
  'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(index % 4 + 1),
).join('\n') + '\n\n'

function Fixture() {
  const [value, setValue] = useState(initialValue)
  const [fontScale, setFontScale] = useState(1)
  const [uiScale, setUiScale] = useState(1)
  const [highlighted, setHighlighted] = useState(true)
  const [inline, setInline] = useState(false)
  const [open, setOpen] = useState(true)
  const [showShell, setShowShell] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const setViewport = ({ height, fullHeight = window.innerHeight, offsetTop = 0, scale = 1, focused = true }: {
    height: number; fullHeight?: number; offsetTop?: number; scale?: number; focused?: boolean
  }) => {
    const root = document.documentElement
    const isIOSStandaloneClient = root.matches('[data-tauri-mobile="ios"], [data-ios-pwa]')
    const inset = computeViewportKeyboardInset({
      fullHeight, viewportHeight: height * scale, offsetTop,
      keyboardActive: focused, ignoreOffsetTop: isIOSStandaloneClient, accessoryMinInset: 44,
    })
    const viewport = computeVisibleViewport({
      fullHeight, viewportHeight: height, offsetTop, scale,
      keyboardInsetBottom: inset, isIOSStandaloneClient,
    })
    root.style.setProperty('--app-viewport-height', `${viewport.height * scale}px`)
    root.style.setProperty('--app-visual-viewport-height', `${viewport.height}px`)
    root.style.setProperty('--app-visual-viewport-width', `${window.innerWidth / scale}px`)
    root.style.setProperty('--app-visual-viewport-offset-top', `${viewport.offsetTop}px`)
    root.style.setProperty('--app-keyboard-inset-bottom', `${inset}px`)
    if (root.matches('[data-tauri-mobile="android"]')) root.style.setProperty('--app-fullscreen-height', `${fullHeight}px`)
    else root.style.removeProperty('--app-fullscreen-height')
    // Exercise the real caret controller as well as CSS layout. iOS can report
    // a stale pan even though the shared variables have neutralized it.
    if (window.visualViewport) {
      for (const [key, value] of Object.entries({ height, offsetTop, scale })) {
        Object.defineProperty(window.visualViewport, key, { configurable: true, value })
      }
      window.visualViewport.dispatchEvent(new Event('resize'))
    }
    window.dispatchEvent(new Event(KEYBOARD_VIEWPORT_EVENT))
  }

  useLayoutEffect(() => {
    const vars = generateThemeVariables({ ...DEFAULT_THEME, fontScale, uiScale }, 'dark')
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value)
    window.dispatchEvent(new Event('resize'))
  }, [fontScale, uiScale])

  useLayoutEffect(() => installKeyboardFocusReveal(), [])

  useLayoutEffect(() => {
    const getCaret = () => getExpandedEditorCaretRect(
      document.querySelector('textarea[data-keyboard-caret-managed]')!, document.querySelector('pre')!,
    )?.toJSON()
    const getFormCaret = () => getExpandedEditorCaretRect(
      document.querySelector('textarea[aria-label="Form text"]')!, document.querySelector('[data-keyboard-caret-mirror]')!,
    )?.toJSON()
    Object.assign(window, { expandedEditorFixture: { setFontScale, setUiScale, setHighlighted, setInline, setValue, setOpen, setShowShell, setShowForm, setViewport, getCaret, getFormCaret } })
  }, [])

  return <>
    {showShell && <div className={app.app} data-fixture-shell>
      <div className={`${wallpaper.layer} ${wallpaper.fixed}`} data-fixture-wallpaper
        style={{ background: 'linear-gradient(#5d4687, #1d1737)' }} />
      <header data-fixture-header style={{ height: 48, flexShrink: 0, position: 'relative' }}>Chat</header>
      <main className={app.main}>
        <div className={input.container} data-component="InputArea" data-fixture-composer><textarea aria-label="Message" /></div>
      </main>
    </div>}
    {open && <ExpandedTextEditor value={value} onChange={setValue} onClose={() => setOpen(false)} title="Editor"
      macros={[]} markdownOnly={highlighted} inline={inline} />}
    <ModalShell isOpen={showForm} onClose={() => setShowForm(false)} fullscreen data-component="KeyboardFixture"
      className={`${worldbook.nativeModal} ${worldbook.nativeFullscreen}`}>
      <header style={{ height: 48, flexShrink: 0 }}>Fullscreen form</header>
      <div data-fixture-form-scroll className={`${entry.entryEditor} ${entry.compactEntryEditor}`}>
        <div style={{ height: 'calc(500px / var(--lumiverse-ui-scale, 1))', flexShrink: 0 }} />
        <textarea aria-label="Form text" defaultValue={Array.from({ length: 12 }, (_, i) => `Form line ${i}`).join('\n')}
          style={{ display: 'block', width: '100%', height: 180, padding: 8, flexShrink: 0 }} />
        <input aria-label="Form name" defaultValue="Name" />
      </div>
      <footer className={worldbook.contentFooter}>Footer</footer>
    </ModalShell>
  </>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
