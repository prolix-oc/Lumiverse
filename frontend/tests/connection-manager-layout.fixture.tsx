import { applyOrganizationEdits } from '../../src/shared/connection-organization-edits'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { flushSettingsNow } from '../src/store/slices/settings'
import { ConnectionSearchProvider } from '../src/components/panels/connection-manager/ConnectionSearch'
import ConnectionManager from '../src/components/panels/ConnectionManager'
import ImageGenConnectionManager from '../src/components/panels/image-gen-connections/ImageGenConnectionManager'
import STTConnectionManager from '../src/components/panels/stt-connections/STTConnectionManager'
import TTSConnectionManager from '../src/components/panels/tts-connections/TTSConnectionManager'
import DecisionConnectionManager from '../src/components/panels/decision-connections/DecisionConnectionManager'
import EmbeddingConnectionManager from '../src/components/panels/embedding-connections/EmbeddingConnectionManager'
import { generateThemeVariables } from '../src/theme/engine'
import { PRESETS } from '../src/theme/presets'
import i18n, { initI18n } from '../src/i18n'
import drawerStyles from '../src/components/panels/ViewportDrawer.module.css'
import '../src/theme/reset.css'
import '../src/theme/global.css'

// Real managers, cards, forms, API clients, settings and drag sensors. Only the
// HTTP boundary is replaced so interaction tests cannot modify a user's data.
const kinds = ['llm', 'imageGen', 'stt', 'tts', 'decision', 'embedding'] as const
const stress = new URL(location.href).searchParams.has('stress')
const profiles = Array.from({ length: stress ? 90 : 15 }, (_, index) => ({
  id: `connection-${index}`, name: ['Vertex Argon', 'Vertex Flash', 'Opus', 'Sonnet'][index % 4] + ` ${index + 1}`,
  provider: 'openai', model: `model-${index}`, api_url: 'https://example.test/v1',
  is_default: index === 0, has_api_key: true, preset_id: null,
  default_parameters: {}, metadata: {}, dimensions: null, enabled: true,
  created_at: 1, updated_at: 1,
}))
const providers = [{ id: 'openai', name: 'OpenAI', default_url: 'https://example.test/v1',
  capabilities: { apiKeyRequired: true, defaultUrl: 'https://example.test/v1', modelListStyle: 'dynamic' } }]
const key = stress ? 'connection-manager-scroll' : 'connection-manager-layout'
const folders = stress
  ? Array.from({ length: 30 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index + 1}` }))
  : [{ id: 'local', name: 'Local' }, { id: 'hosted', name: 'Hosted' }]
const library = { folders, folderOrder: [...folders.map(folder => folder.id), ''],
  assignments: stress ? Object.fromEntries(profiles.slice(0, 89).map((profile, index) =>
    [profile.id, index < 60 ? 'folder-0' : `folder-${index - 59}`])) : {} }
if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
  activeProfileId: profiles[0].id,
  recentConnections: Object.fromEntries(kinds.map(kind => [kind, profiles.slice(0, 8).map(profile => profile.id)])),
  connectionLibraries: Object.fromEntries(kinds.map(kind => [kind, library])),
}))
const requests: { path: string; method: string; body: unknown }[] = []
const fixture = { store: useStore, flush: flushSettingsNow, requests, failNextUpdate: false,
  holdNextUpdate: false, releaseUpdate: () => {} }
const originalFetch = window.fetch.bind(window)
let config = { provider: 'openai', model: profiles[0].model, api_url: profiles[0].api_url,
  dimensions: null, enabled: true, connectionProfiles: profiles, inherited: false }
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  if (!url.pathname.includes('/api/v1/')) return originalFetch(input, init)
  const path = url.pathname.replace('/api/v1', '')
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  requests.push({ path, method, body })
  if (path === '/connections/organization/edit') {
    const updated = applyOrganizationEdits(JSON.parse(localStorage.getItem(key)!), body)
    localStorage.setItem(key, JSON.stringify(updated))
    return Response.json(Object.fromEntries(['connectionLibraries', 'connectionsOrder', 'recentConnections'].map(k => [k, updated[k] ?? {}])))
  }
  if (path === '/settings') {
    const settings = JSON.parse(localStorage.getItem(key)!)
    if (method === 'PUT') {
      Object.assign(settings, body)
      localStorage.setItem(key, JSON.stringify(settings))
    }
    return Response.json(Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: 1 })))
  }
  if (path.endsWith('/providers')) return Response.json({ providers })
  if (path.includes('/models')) return Response.json({
    models: path.startsWith('/connections/') || path.startsWith('/embeddings/')
      ? ['model-0', 'model-1'] : [{ id: 'model-0', label: 'Model 0' }, { id: 'model-1', label: 'Model 1' }],
    model_labels: {},
  })
  if (path.includes('/voices')) return Response.json({ voices: [] })
  if (path === '/embeddings/config') {
    if (method === 'PUT') config = { ...config, ...body }
    return Response.json(config)
  }
  if (path.includes('connections')) {
    if (method === 'PUT') {
      if (fixture.holdNextUpdate) {
        fixture.holdNextUpdate = false
        await new Promise<void>(resolve => { fixture.releaseUpdate = resolve })
      }
      if (fixture.failNextUpdate) {
        fixture.failNextUpdate = false
        return Response.json({ error: 'Save failed' }, { status: 500 })
      }
      const profile = profiles.find(profile => path.endsWith(`/${profile.id}`))!
      Object.assign(profile, body, { updated_at: profile.updated_at + 1 })
      return Response.json(profile)
    }
    if (method === 'POST') return Response.json({ ...profiles[0], ...body, id: 'created' })
    return Response.json({ data: profiles, total: profiles.length, limit: 100, offset: 0 })
  }
  return Response.json({})
}
await initI18n()
await i18n.changeLanguage('en')
useStore.setState({ profiles, providers, imageGenProfiles: profiles, imageGenProviders: providers,
  sttProfiles: profiles, sttProviders: providers, ttsProfiles: profiles, ttsProviders: providers,
  decisionProfiles: profiles, decisionProviders: providers })
await useStore.getState().loadSettings()
Object.entries(generateThemeVariables(PRESETS.find(theme => theme.name === 'Rose')!, 'dark'))
  .forEach(([name, value]) => document.documentElement.style.setProperty(name, value))
const scale = Number(new URL(location.href).searchParams.get('scale') || 1)
document.documentElement.style.setProperty('--lumiverse-ui-scale', String(scale))
const managers = { llm: ConnectionManager, imageGen: ImageGenConnectionManager, stt: STTConnectionManager,
  tts: TTSConnectionManager, decision: DecisionConnectionManager, embedding: EmbeddingConnectionManager }
const kind = (new URL(location.href).searchParams.get('kind') || 'llm') as typeof kinds[number]
const Manager = managers[kind]
Object.assign(window, { layoutFixture: fixture })
createRoot(document.getElementById('root')!).render(
  <main className={drawerStyles.panelContent} style={{ width: '100%', maxWidth: 830, height: 'var(--app-scaled-viewport-height)' }}>
    <ConnectionSearchProvider><Manager /></ConnectionSearchProvider>
  </main>,
)
