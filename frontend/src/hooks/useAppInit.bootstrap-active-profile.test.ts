import { describe, expect, mock, test } from 'bun:test'
import type { BootstrapPayload, LandingBootstrapPayload } from '@/api/bootstrap'
import type { ConnectionProfile } from '@/types/api'

const calls: string[] = []
const store = {
  settingsLoaded: false,
  hydrateStartupSettings(settings: { activeProfileId?: string | null }) {
    calls.push(`hydrate:${settings.activeProfileId ?? 'null'}`)
    store.settingsLoaded = true
  },
  setProfiles(profiles: ConnectionProfile[]) {
    calls.push(`profiles:${profiles.map((item) => item.id).join(',')}`)
  },
  setProviders() {},
  setSttProfiles() {},
  setSttProviders() {},
  setTtsProfiles() {},
  setTtsProviders() {},
  setImageGenProfiles() {},
  setImageGenProviders() {},
  setPacks() {},
  setPersonas() {},
  setRegexScripts() {},
  setLandingRecentChats() {
    calls.push('recent-chats')
  },
  setCouncilSettings() {},
  setCouncilPersistenceTarget() {},
  hydrateCouncilTools() {},
}

mock.module('@/store', () => ({
  useStore: Object.assign((selector?: (value: typeof store) => unknown) => (
    selector ? selector(store) : store
  ), {
    getState: () => store,
  }),
}))

const { applyBootstrap, applyLandingBootstrap } = await import('./useAppInit')

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    api_url: '',
    model: 'gpt-test',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    review_required: false,
    review_code: null,
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

function emptyPage<T>(data: T[] = []) {
  return { data, total: data.length, limit: data.length, offset: 0 }
}

describe('useAppInit bootstrap activeProfileId', () => {
  test('hydrates activeProfileId from startup settings before connection profiles land', () => {
    calls.length = 0
    store.settingsLoaded = false
    const payload = {
      startupSettings: { activeProfileId: 'saved-profile' },
      llm: { connections: emptyPage([profile('saved-profile')]), providers: [] },
      stt: { connections: emptyPage(), providers: [] },
      tts: { connections: emptyPage(), providers: [] },
      imageGen: { connections: emptyPage(), providers: [] },
      packs: emptyPage(),
      personas: emptyPage(),
      regexScripts: emptyPage(),
      council: { settings: { members: [], toolsSettings: {} }, tools: [] },
      spindle: { extensions: [], isPrivileged: false, tools: [] },
      recentChats: emptyPage(),
    } as unknown as BootstrapPayload

    applyBootstrap(payload, {}, {})
    expect(calls[0]).toBe('hydrate:saved-profile')
    expect(calls[1]).toBe('profiles:saved-profile')
  })

  test('landing bootstrap hydrates activeProfileId before recent chats', () => {
    calls.length = 0
    store.settingsLoaded = false
    applyLandingBootstrap(
      {
        startupSettings: { activeProfileId: 'landing-profile' },
        recentChats: emptyPage(),
      } as LandingBootstrapPayload,
      {},
      {},
    )
    expect(calls[0]).toBe('hydrate:landing-profile')
    expect(calls[1]).toBe('recent-chats')
  })
})
