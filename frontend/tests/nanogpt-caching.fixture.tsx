import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ConnectionForm from '../src/components/panels/connection-manager/ConnectionForm'
import type { ConnectionProfile, CreateConnectionProfileInput } from '../src/types/api'
import panels from '../src/i18n/locales/en/panels.json'
import common from '../src/i18n/locales/en/common.json'
import '../src/theme/global.css'

await i18n.use(initReactI18next).init({
  lng: 'en', resources: { en: { panels, common } }, initImmediate: false,
})

function Fixture() {
  const [profile, setProfile] = useState<ConnectionProfile>(() => ({
    id: 'nanogpt-review', name: 'NanoGPT review', provider: 'nanogpt',
    model: 'anthropic/claude-sonnet-4-5', api_url: '', has_api_key: false,
    is_default: false, preset_id: null, default_parameters: {}, created_at: 1, updated_at: 1,
    metadata: JSON.parse(localStorage.getItem('nanogpt-review-metadata') || '{}'),
  } as ConnectionProfile))
  const [saved, setSaved] = useState<CreateConnectionProfileInput | null>(null)
  return <main style={{ padding: 16 }}>
    <ConnectionForm providers={[]} profile={profile} onCancel={() => {}} onSave={input => {
      localStorage.setItem('nanogpt-review-metadata', JSON.stringify(input.metadata))
      setSaved(input)
      setProfile(current => ({ ...current, ...input } as ConnectionProfile))
    }} />
    <output aria-label="Saved connection">{JSON.stringify(saved)}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
