import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import ModalContainer from '../src/components/modals/ModalContainer'
import { ensureRegistryRoot, preloadDrawerTab } from '../src/lib/drawer-tab-registry'
import { useDrawerTabPreload } from '../src/hooks/useDrawerTabPreload'
import ContainerTabContent from '../src/components/spindle/ContainerTabContent'

export const useFixtureStore = create<any>((set) => ({
  settingsModalOpen: false, activeModal: null, modalProps: {}, lastRegenFeedback: {}, commandPaletteOpen: false,
  closeSettings: () => set({ settingsModalOpen: false }), closeModal: () => set({ activeModal: null }),
  setLastRegenFeedback: () => {}, openSettings: () => set({ settingsModalOpen: true }),
  containers: [], tabLocations: {}, drawerTabs: [], extensions: [], hiddenPlacements: [], moveTabTo: () => {},
}))

const panel = document.createElement('main')
panel.style.cssText = 'width:420px;height:560px;position:fixed;left:320px;top:100px;border:1px solid gray'
document.body.append(panel)
const gates: Record<string, Promise<void>> = {}
const releases: Record<string, () => void> = {}
;(window as any).loadingBoundariesFixture = {
  gates, store: useFixtureStore,
  preload: preloadDrawerTab,
  showPanel(id: string) {
    const root = ensureRegistryRoot(id)
    if (!root) throw new Error(`Unknown panel: ${id}`)
    panel.replaceChildren(root)
  },
  hold(name: string) { gates[name] = new Promise(resolve => { releases[name] = resolve }) },
  release(name: string) { delete gates[name]; releases[name](); delete releases[name] },
}
function PreloadControls() {
  const intent = useDrawerTabPreload()
  return <nav>{['connections', 'profile', 'personas', 'loom', 'theme', 'weaver'].map(id => (
    <button key={id} data-preload-tab={id} {...intent(id)} onClick={() => preloadDrawerTab(id)}>{id}</button>
  ))}</nav>
}
createRoot(document.getElementById('root')!).render(<><PreloadControls /><ModalContainer /><ContainerTabContent /></>)
