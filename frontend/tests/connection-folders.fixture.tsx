import { useState } from 'react'
import { applyOrganizationEdits } from '../../src/shared/connection-organization-edits'
import type { ConnectionLibraryKind } from '../src/lib/connectionLibrary'
import EmbeddingConnectionPicker from '../src/components/shared/EmbeddingConnectionPicker'
import ConnectionForm from '../src/components/panels/connection-manager/ConnectionForm'
import type { CreateConnectionProfileInput, Persona } from '../src/types/api'
import { createRoot } from 'react-dom/client'
import { useConnectionRow } from '../src/components/panels/connection-manager/useConnectionRow'
import type { ConnectionPlacement } from '../src/lib/connectionPlacement'
import { useStore } from '../src/store'
import { flushSettingsNow } from '../src/store/slices/settings'
import ConnectionCollection from '../src/components/panels/connection-manager/ConnectionCollection'
import { ConnectionSearchProvider } from '../src/components/panels/connection-manager/ConnectionSearch'
import ConnectionSelect from '../src/components/shared/ConnectionSelect'
import ConnectionQuickPicker from '../src/components/shared/ConnectionQuickPicker'
import SettingsModal from '../src/components/modals/SettingsModal'
import PersonaManager from '../src/components/panels/PersonaManager'
import { ConnectionsPicker } from '../src/components/connections-picker/ConnectionsPicker'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import i18n, { initI18n } from '../src/i18n'
import '../src/theme/reset.css'
import '../src/theme/global.css'

// This fixture replaces only HTTP settings storage. The store's real write,
// debounce, hydration and selector paths run against a reloadable local record.
const storageKey = 'connection-folders-fixture-settings'
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = String(input)
  if (!url.includes('/api/v1/')) return originalFetch(input, init)
  const settings = JSON.parse(localStorage.getItem(storageKey) || '{}')
  if (url.endsWith('/connections/organization/edit')) {
    const updated = applyOrganizationEdits(settings, JSON.parse(String(init?.body)))
    localStorage.setItem(storageKey, JSON.stringify(updated))
    return Response.json(Object.fromEntries(['connectionLibraries', 'connectionsOrder', 'recentConnections'].map(key => [key, updated[key] ?? {}])))
  }
  if (/\/connections\/[^/]+\/models(?:\?.*)?$/.test(url)) return Response.json({ models: [], model_labels: {} })
  if (url.endsWith('/settings')) {
    if (init?.method === 'PUT') {
      Object.assign(settings, JSON.parse(String(init.body)))
      localStorage.setItem(storageKey, JSON.stringify(settings))
    }
    return Response.json(Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: 1 })))
  }
  return Response.json({})
}

const profiles = [
  { id: 'a', name: 'Alpha', provider: 'openai', model: 'model-a' },
  { id: 'b', name: 'Beta', provider: 'anthropic', model: 'model-b' },
  { id: 'c', name: 'Gamma', provider: 'openai', model: 'model-c' },
].map(profile => ({ ...profile, api_url: '', preset_id: null, is_default: false, has_api_key: false, metadata: {}, default_parameters: {}, dimensions: null, enabled: true, created_at: 1, updated_at: 1 }))
const personas: Persona[] = ['one', 'two', 'three'].map(id => ({
  id, name: `Persona ${id}`, title: '', description: '', folder: '',
  subjective_pronoun: '', objective_pronoun: '', possessive_pronoun: '',
  reflexive_pronoun: '', possessive_pronoun_standalone: '',
  avatar_path: null, image_id: null, attached_world_book_id: null,
  is_default: false, is_narrator: false, metadata: {}, created_at: 1, updated_at: 1,
}))
const initialLibrary = {
  folders: [{ id: 'local', name: 'Local' }, { id: 'remote', name: 'Remote' }],
  folderOrder: ['local', 'remote', ''], assignments: { a: 'local', b: 'remote' },
}
if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({
  connectionLibraries: Object.fromEntries(['llm', 'imageGen', 'stt', 'tts', 'decision', 'embedding'].map(kind => [kind, initialLibrary])), activeProfileId: 'a',
}))
await initI18n()
await i18n.changeLanguage('en')
Object.entries(generateThemeVariables(DEFAULT_THEME, 'dark')).forEach(([key, value]) => document.documentElement.style.setProperty(key, value))
useStore.setState({ profiles, imageGenProfiles: profiles, sttProfiles: profiles, ttsProfiles: profiles, decisionProfiles: profiles })
useStore.getState().setPersonas(personas)
await useStore.getState().loadSettings()
if (new URL(location.href).searchParams.get('picker') === 'full') {
  useStore.setState(state => ({
    extensions: [{ id: 'suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }] as typeof state.extensions,
    connectionsPickerSettings: { ...state.connectionsPickerSettings, enabled: true, variant: 'split' },
  }))
}

function Row({ profile, placement }: { placement: ConnectionPlacement; profile: typeof profiles[number] }) {
  const [draft, setDraft] = useState('')
  const sortable = useConnectionRow(profile.id, placement)
  const { setNodeRef, style } = sortable
  return <div ref={setNodeRef} style={{ ...style, border: '1px solid gray', padding: 12 }}>
    <button {...sortable.attributes} {...sortable.listeners} aria-label={`Move ${profile.name}`}>↕</button>
    <input aria-label={`Draft ${profile.name}`} value={draft} onChange={event => setDraft(event.target.value)} />
    <span> {profile.name} · {profile.model} </span>
    <button onClick={() => useStore.getState().setActiveProfile(profile.id)}>Use {profile.name}</button>
  </div>
}

function Fixture() {
  const currentProfiles = useStore(state => state.profiles)
  const activeId = useStore(state => state.activeProfileId)
  const kind = (new URL(location.href).searchParams.get('kind') || 'llm') as ConnectionLibraryKind
  const [selected, setSelected] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [saved, setSaved] = useState<CreateConnectionProfileInput | null>(null)
  if (new URL(location.href).searchParams.get('settings') === 'display') {
    return <SettingsModal onClose={() => { location.search = '' }} />
  }
  if (new URL(location.href).searchParams.get('personas') === 'manager') {
    return <PersonaManager />
  }
  if (new URL(location.href).searchParams.get('picker') === 'full') {
    return <ConnectionsPicker open onClose={() => {}} />
  }
  if (new URL(location.href).searchParams.get('picker') === 'roulette') {
    return <main><ConnectionForm providers={[]} initialProvider="model_roulette" onSave={setSaved} onCancel={() => {}} />
      <output aria-label="Saved roulette">{JSON.stringify(saved)}</output></main>
  }
  if (new URL(location.href).searchParams.get('picker') === 'quick') {
    return <div style={{ width: 360, maxWidth: '100%' }}><ConnectionQuickPicker onSelect={id => useStore.getState().setActiveProfile(id)} /></div>
  }
  return <main style={{ padding: 24, width: 520, maxWidth: '100%', height: '100%', overflow: 'auto' }}>
    <ConnectionSearchProvider>
      <ConnectionCollection kind={kind} profiles={currentProfiles} emptyMessage="No connections"
        onReorder={ids => {
          useStore.getState().applyProfileOrder(ids)
          useStore.getState().setSetting('connectionsOrder', { ...useStore.getState().connectionsOrder, llm: ids })
        }} renderProfile={(profile, placement) => <Row profile={profile} placement={placement} />} />
    </ConnectionSearchProvider>
    <div style={{ marginTop: 20 }}>
      {kind === 'embedding'
        ? <EmbeddingConnectionPicker label="Choose connection" profiles={profiles} connectionProfileId={selected}
            model={model} onConnectionChange={setSelected} onModelChange={setModel} />
        : <ConnectionSelect kind={kind} value={kind === 'llm' ? activeId ?? '' : selected ?? ''}
            onChange={id => kind === 'llm' ? useStore.getState().setActiveProfile(id) : setSelected(id)} ariaLabel="Choose connection" />}
      <output aria-label="Selected model">{model}</output>
    </div>
  </main>
}

Object.assign(window, { connectionFixture: { store: useStore, flush: flushSettingsNow } })
createRoot(document.getElementById('root')!).render(<Fixture />)
