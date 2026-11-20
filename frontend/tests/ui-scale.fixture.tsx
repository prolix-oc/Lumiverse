import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ModalShell } from '../src/components/shared/ModalShell'
import ContextMenu from '../src/components/shared/ContextMenu'
import SearchableSelect from '../src/components/shared/SearchableSelect'
import { DndContext, useScaledSortableStyle } from '../src/lib/dndUiScale'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import appStyles from '../src/App.module.css'
import settingsStyles from '../src/components/modals/SettingsModal.module.css'
import '../src/theme/reset.css'
import '../src/theme/global.css'

void i18next.use(initReactI18next).init({ lng: 'en', resources: {}, initImmediate: false })

const ids = Array.from({ length: 16 }, (_, index) => `row-${index}`)
function SortableRow({ id }: { id: string }) {
  const sortable = useSortable({ id })
  const { setNodeRef, style } = useScaledSortableStyle(sortable)
  return <div id={id} ref={setNodeRef} {...sortable.attributes} {...sortable.listeners}
    style={{ ...style, height: 48, flexShrink: 0, border: '1px solid gray', touchAction: 'none' }}>{id}</div>
}

function Fixture() {
  const [scale, setScale] = useState(1)
  const [shell, setShell] = useState(true)
  const [modal, setModal] = useState(false)
  const [compact, setCompact] = useState(false)
  const [settings, setSettings] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [maxWidth, setMaxWidth] = useState<string | number>(560)
  const [maxHeight, setMaxHeight] = useState<string | number>('90vh')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [value, setValue] = useState('first')

  useLayoutEffect(() => {
    const vars = generateThemeVariables({ ...DEFAULT_THEME, uiScale: scale }, 'dark')
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value)
    window.dispatchEvent(new Event('resize'))
  }, [scale])

  useLayoutEffect(() => {
    Object.assign(window, { uiScaleFixture: { setScale, setShell, setModal, setMenu, setCompact, setSettings, setFullscreen, setMaxWidth, setMaxHeight } })
  }, [])

  return <>
    <div id="surface" className={shell ? appStyles.app : undefined} style={shell ? undefined : { width: '100%', height: '100%' }}>
      <div id="fixed-control" style={{ position: 'fixed', right: 16, bottom: 16, width: 100, height: 40 }} />
      <div style={{ position: 'absolute', top: 80, left: 24, width: 240, maxWidth: 'calc(100% - 48px)' }}>
        <SearchableSelect ariaLabel="Scale test select" portal value={value} onChange={setValue}
          options={[{ value: 'first', label: 'First option' }, { value: 'second', label: 'Second option' }]} />
      </div>
      <div id="drag-scroll" style={{ position: 'absolute', top: 160, left: 24, width: 240, maxWidth: 'calc(100% - 48px)', height: 200, overflow: 'auto' }}>
        <DndContext autoScroll={false}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {ids.map(id => <SortableRow key={id} id={id} />)}
          </SortableContext>
        </DndContext>
      </div>
    </div>
    {createPortal(<>
      <div id="direct-portal" style={{ position: 'fixed', right: 16, bottom: 16, width: 100, height: 40 }} />
      <div id="portal-wrapper"><div id="nested-portal" style={{ position: 'fixed', right: 16, bottom: 16, width: 100, height: 40 }} /></div>
      <div id="full-portal" style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />
      <div id="center-portal" style={{ position: 'fixed', left: '50%', top: '50%', width: 100, height: 40, transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
    </>, document.body)}
    <ModalShell isOpen={modal} onClose={() => setModal(false)} fullscreen={fullscreen} maxWidth={compact ? 420 : maxWidth} maxHeight={maxHeight} scrollable><div id="modal-content" style={{ height: compact ? 120 : 1200, flexShrink: 0 }}>Modal</div></ModalShell>
    {settings && createPortal(<div className={settingsStyles.overlay}><div id="settings-fixture" className={settingsStyles.modal}>Settings</div></div>, document.body)}
    <ContextMenu position={menu} onClose={() => setMenu(null)} items={[{ key: 'item', label: 'Menu item', onClick: () => setMenu(null) }]} />
  </>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
