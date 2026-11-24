import { createRoot } from 'react-dom/client'
import MigrationSettings from '../src/components/settings/MigrationSettings'
import { useStore } from '../src/store'
import i18n, { initI18n } from '../src/i18n'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import '../src/theme/reset.css'
import '../src/theme/global.css'

const user = { id: 'review-owner', role: 'owner', name: 'Review Owner' } as NonNullable<ReturnType<typeof useStore.getState>['user']>
useStore.setState({ user, listUsers: async () => [user] })
const counts = { characters: 2, chatDirs: 2, totalChatFiles: 3, groupChats: 1, groupChatFiles: 1, worldBooks: 1, personas: 1 }
let request: unknown
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  const route = url.pathname.replace('/api/v1', '')
  if (route === '/st-migration/status') return Response.json({ status: 'idle' })
  if (route === '/google-drive/auth/status' || route === '/dropbox/auth/status') return Response.json({ configured: false, authorized: false })
  if (route === '/st-migration/connection-types') return Response.json({ types: ['local', 'sftp'] })
  if (route === '/st-migration/browse') return Response.json({ path: '/fixture/st', parent: null, entries: [] })
  if (route === '/st-migration/validate') return Response.json({ valid: true, basePath: '/fixture/st', layout: 'legacy' })
  if (route === '/st-migration/scan') return Response.json(counts)
  if (route === '/st-migration/execute') {
    request = JSON.parse(String(init?.body))
    return Response.json({ migrationId: 'review-migration' })
  }
  return originalFetch(input, init)
}
await initI18n()
await i18n.changeLanguage('en')
Object.entries(generateThemeVariables(DEFAULT_THEME, 'dark')).forEach(([key, value]) => document.documentElement.style.setProperty(key, value))
const fixture = {
  get request() { return request },
  get phase() { return useStore.getState().migrationPhase },
  progress() {
    useStore.getState().setMigrationProgress({ migrationId: 'review-migration', phase: 'gallery', label: 'Importing gallery', current: 1, total: 2 })
  },
  complete() {
    useStore.getState().setMigrationCompleted({ migrationId: 'review-migration', durationMs: 2000, results: { gallery: { imported: 2, skipped: 1, failed: 0, rewrites: 4 } } })
  },
}
declare global { interface Window { migrationReview: typeof fixture } }
window.migrationReview = fixture
createRoot(document.getElementById('root')!).render(<main style={{ width: '100%', maxWidth: 880, minWidth: 0, boxSizing: 'border-box', margin: 'auto', padding: 16 }}><MigrationSettings /></main>)
