import { useEffect, useRef } from 'react'
import { COUNCIL_SETTINGS_DEFAULTS, COUNCIL_TOOLS_DEFAULTS } from 'lumiverse-spindle-types'
import { useStore } from '@/store'
import { bootstrapApi, type BootstrapPayload } from '@/api/bootstrap'
import { connectionsApi } from '@/api/connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { personasApi } from '@/api/personas'
import { packsApi } from '@/api/packs'

/**
 * Eagerly load shared data that multiple panels depend on.
 * Runs once after authentication succeeds.
 *
 * Primary path: `GET /api/v1/bootstrap` — a single aggregated request that
 * returns connections, providers, packs, personas, regex scripts, council
 * settings + tools, and spindle extensions + tools all at once. Saves ~8
 * HTTP round trips at cold start.
 *
 * Fallback path: if the bootstrap call fails entirely, or reports per-section
 * errors, the original per-endpoint fan-out fires for just the missing
 * sections so a partial outage can't block sign-in.
 */
export function useAppInit() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const didInit = useRef(false)

  useEffect(() => {
    if (!isAuthenticated || didInit.current) return
    didInit.current = true

    void initialize()
  }, [isAuthenticated])
}

async function initialize(): Promise<void> {
  let payload: BootstrapPayload | null = null
  let errors: Record<string, string> = {}

  try {
    const response = await bootstrapApi.fetch()
    payload = response.payload
    errors = response.errors ?? {}
  } catch (err) {
    // Complete bootstrap failure — every section needs the fallback path.
    console.warn('[useAppInit] bootstrap failed, falling back to per-endpoint fetches:', err)
    errors = {
      'llm.connections': 'fallback', 'llm.providers': 'fallback',
      'tts.connections': 'fallback', 'tts.providers': 'fallback',
      'imageGen.connections': 'fallback', 'imageGen.providers': 'fallback',
      'packs': 'fallback', 'personas': 'fallback', 'regexScripts': 'fallback',
      'council.settings': 'fallback', 'council.tools': 'fallback',
      'spindle': 'fallback',
    }
  }

  if (payload) applyBootstrap(payload, errors)
  if (Object.keys(errors).length > 0) await runFallbacks(errors)

  // Council member pack items — always run after settings are loaded.
  // Walks the (now-populated) council member list and fetches full pack
  // details for each unique member pack so OOC avatars render immediately.
  const { councilSettings, packsWithItems } = useStore.getState()
  const memberPackIds = new Set(
    councilSettings.members.map((m) => m.packId).filter(Boolean),
  )
  for (const packId of memberPackIds) {
    if (!packsWithItems[packId]) {
      packsApi.get(packId)
        .then((data) => useStore.getState().setPackWithItems(packId, data))
        .catch(() => {})
    }
  }
}

/** Fan the bootstrap payload into the store, skipping any section that
 *  the backend reported as failed (the fallback pass will retry those). */
function applyBootstrap(payload: BootstrapPayload, errors: Record<string, string>): void {
  const store = useStore.getState()

  if (!errors['llm.connections']) store.setProfiles(payload.llm.connections.data)
  if (!errors['llm.providers']) store.setProviders(payload.llm.providers)

  if (!errors['tts.connections']) store.setTtsProfiles(payload.tts.connections.data)
  if (!errors['tts.providers']) store.setTtsProviders(payload.tts.providers)

  if (!errors['imageGen.connections']) store.setImageGenProfiles(payload.imageGen.connections.data)
  if (!errors['imageGen.providers']) store.setImageGenProviders(payload.imageGen.providers)

  if (!errors['packs']) store.setPacks(payload.packs.data)
  if (!errors['personas']) store.setPersonas(payload.personas.data)
  if (!errors['regexScripts']) store.setRegexScripts(payload.regexScripts.data)

  if (!errors['council.settings']) {
    // Mirror the normalization from council.slice.ts:loadCouncilSettings —
    // merge in defaults so missing keys don't surface as `undefined`.
    const storedTools = payload.council.settings?.toolsSettings ?? {}
    store.setCouncilSettings({
      ...COUNCIL_SETTINGS_DEFAULTS,
      ...payload.council.settings,
      toolsSettings: { ...COUNCIL_TOOLS_DEFAULTS, ...storedTools },
    })
  }

  // Council tools merge needs spindle data; only hydrate when both sections
  // succeeded. A partial failure will fall through to `loadAvailableTools`
  // in the fallback pass which refetches both endpoints.
  if (!errors['council.tools'] && !errors['spindle']) {
    store.hydrateCouncilTools(
      payload.council.tools,
      payload.spindle.tools,
      payload.spindle.extensions,
    )
  }
}

/** Fill in sections the bootstrap payload couldn't provide by calling the
 *  original per-endpoint APIs. Each fallback is fire-and-forget so one
 *  failing section can't block the others. */
async function runFallbacks(errors: Record<string, string>): Promise<void> {
  const store = useStore.getState()

  if (errors['llm.connections'] || errors['llm.providers']) {
    Promise.allSettled([
      connectionsApi.list({ limit: 100 }),
      connectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (profilesRes.status === 'fulfilled') store.setProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setProviders(providersRes.value.providers)
    })
  }

  if (errors['tts.connections'] || errors['tts.providers']) {
    Promise.allSettled([
      ttsConnectionsApi.list({ limit: 100 }),
      ttsConnectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (profilesRes.status === 'fulfilled') store.setTtsProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setTtsProviders(providersRes.value.providers)
    })
  }

  if (errors['imageGen.connections'] || errors['imageGen.providers']) {
    Promise.allSettled([
      imageGenConnectionsApi.list({ limit: 100 }),
      imageGenConnectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (profilesRes.status === 'fulfilled') store.setImageGenProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setImageGenProviders(providersRes.value.providers)
    })
  }

  if (errors['packs']) {
    packsApi.list({ limit: 200 }).then((res) => store.setPacks(res.data)).catch(() => {})
  }

  if (errors['personas']) {
    personasApi.list({ limit: 200 }).then((res) => store.setPersonas(res.data)).catch(() => {})
  }

  if (errors['regexScripts']) {
    store.loadRegexScripts().catch(() => {})
  }

  if (errors['council.settings']) {
    await store.loadCouncilSettings().catch(() => {})
  }

  if (errors['council.tools'] || errors['spindle']) {
    await store.loadAvailableTools()
  }
}
