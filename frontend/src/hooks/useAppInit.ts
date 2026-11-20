import { useEffect, useRef } from 'react'
import { COUNCIL_SETTINGS_DEFAULTS, COUNCIL_TOOLS_DEFAULTS } from 'lumiverse-spindle-types'
import { useStore } from '@/store'
import { bootstrapApi, type BootstrapPayload, type LandingBootstrapPayload } from '@/api/bootstrap'
import { connectionsApi } from '@/api/connections'
import { sttConnectionsApi } from '@/api/stt-connections'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { personasApi } from '@/api/personas'
import { packsApi } from '@/api/packs'
import { resetUserScopedStoreState } from '@/store/user-scoped-reset'
import { flushSettingsNow, setSettingsPersistenceScope } from '@/store/slices/settings'
import { setPresetSaveCoordinatorScope } from '@/lib/loom/preset-save-coordinator'
import { listAllConnections } from '@/api/listAllConnections'
import { useTokenizerWarmup } from './useTokenizerWarmup'
import { activeTab } from '@/lib/active-tab'
import { clearLandingPageSnapshot } from '@/lib/landingPageSnapshot'
import { forgetImportJob, watchImportJob } from '@/lib/import-recovery'
import { reloadImportedData, takeImportReloadReceipt } from '@/lib/import-data-reload'
import { clearImageCache } from '@/lib/imageDecodeCache'
import { userDataApi } from '@/api/user-data'
import { toast } from '@/lib/toast'
import { t } from 'i18next'

let appInitGeneration = 0
const importRefreshes = new Map<string, Promise<void>>()

/** Both WebSocket completion and status polling use this same refresh path. */
export function refreshAppDataAfterImport(jobId: string): Promise<void> {
  const userId = useStore.getState().user?.id
  if (!userId || !useStore.getState().isAuthenticated || activeTab.signal.aborted) return Promise.resolve()
  const key = `${userId}:${jobId}`
  const existing = importRefreshes.get(key)
  if (existing) return existing
  const generation = ++appInitGeneration
  const isCurrent = () => !activeTab.signal.aborted && appInitGeneration === generation
    && useStore.getState().isAuthenticated && useStore.getState().user?.id === userId

  const refresh = (async () => {
    // Finish local settings edits before the new document reads the database.
    await flushSettingsNow()
    if (!isCurrent()) return
    clearLandingPageSnapshot()
    clearImageCache()
    // Bootstrap alone leaves mounted editors, paginated lists, registries
    // and extension-owned caches on their old snapshots. A restore is
    // infrequent: restart every data view together at the current URL.
    forgetImportJob(userId, jobId)
    reloadImportedData(userId, jobId)
  })().then(() => {
    if (!isCurrent()) importRefreshes.delete(key)
  }).catch((error) => {
    importRefreshes.delete(key)
    throw error
  })
  importRefreshes.set(key, refresh)
  // Keep recent completions deduplicated without growing for the whole session.
  if (importRefreshes.size > 100) importRefreshes.delete(importRefreshes.keys().next().value!)
  return refresh
}

/**
 * Eagerly load shared data that multiple panels depend on.
 * Runs once after authentication succeeds.
 *
 * Primary path: `GET /api/v1/bootstrap` — a single aggregated request that
 * returns startup settings, connections, providers, packs, personas, regex
 * scripts, council settings + tools, and spindle extensions + tools all at
 * once. Saves ~8 HTTP round trips at cold start.
 *
 * Fallback path: if the bootstrap call fails entirely, or reports per-section
 * errors, the original per-endpoint fan-out fires for just the missing
 * sections so a partial outage can't block sign-in.
 */
export function useAppInit() {
  useTokenizerWarmup()
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const userId = useStore((s) => s.user?.id ?? null)
  const initializedUserId = useRef<string | null>(null)

  useEffect(() => {
    if (isAuthenticated && userId) return watchImportJob(userId, refreshAppDataAfterImport)
  }, [isAuthenticated, userId])

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      if (initializedUserId.current !== null) {
        resetUserScopedStoreState()
      }
      initializedUserId.current = null
      appInitGeneration += 1
      setSettingsPersistenceScope(null)
      setPresetSaveCoordinatorScope(null)
      return
    }

    if (initializedUserId.current === userId) return
    if (initializedUserId.current && initializedUserId.current !== userId) {
      resetUserScopedStoreState()
    }
    setSettingsPersistenceScope(userId)
    setPresetSaveCoordinatorScope(userId)
    initializedUserId.current = userId
    const generation = ++appInitGeneration
    const isCurrent = () => (
      !activeTab.signal.aborted && appInitGeneration === generation
      && useStore.getState().isAuthenticated
      && useStore.getState().user?.id === userId
    )

    const reloadedJob = takeImportReloadReceipt(userId)
    void initialize(isCurrent).then(async () => {
      if (!reloadedJob || !isCurrent()) return
      try {
        const job = await userDataApi.getImportStatus(reloadedJob)
        if (!isCurrent()) return
        if (job.status === 'complete') toast.success(t('dataPortability.importComplete', { ns: 'settings' }))
        else if (job.status === 'failed' || job.status === 'cancelled') {
          toast.error(job.error || t(job.status === 'cancelled' ? 'dataPortability.importCancelled' : 'dataPortability.importFailed', { ns: 'settings' }))
        }
      } catch { /* A restarted backend may no longer retain the old job. */ }
    })
  }, [isAuthenticated, userId])
}

async function loadFullSettings(isCurrent: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2 && !useStore.getState().fullSettingsLoaded; attempt += 1) {
    if (!isCurrent()) return
    await useStore.getState().loadSettings().catch(() => {})
  }
}

async function initialize(isCurrent: () => boolean): Promise<void> {
  let payload: BootstrapPayload | null = null
  let errors: Record<string, string> = {}
  let landingPreloadHandled = false
  const imageGenProfilesVersion = useStore.getState().imageGenProfilesVersion

  // Recent-chat grouping is landing data, not a prerequisite for direct chat
  // navigation or native widget startup.
  const landingPromise = window.location.pathname === '/' ? bootstrapApi.fetchLanding()
    .then((response) => {
      if (!isCurrent()) return
      const appliedRecentChats = applyLandingBootstrap(response.payload, response.errors ?? {}, {
        skipRecentChats: landingPreloadHandled,
      })
      if (appliedRecentChats) landingPreloadHandled = true
    })
    .catch((err) => {
      console.warn('[useAppInit] landing bootstrap failed; landing page will fetch its own chats:', err)
    }) : Promise.resolve()

  try {
    const response = await bootstrapApi.fetch()
    payload = response.payload
    errors = response.errors ?? {}
  } catch (err) {
    // Complete bootstrap failure — every section needs the fallback path.
    console.warn('[useAppInit] bootstrap failed, falling back to per-endpoint fetches:', err)
    errors = {
      'startupSettings': 'fallback',
      'llm.connections': 'fallback', 'llm.providers': 'fallback',
      'decision.connections': 'fallback', 'decision.providers': 'fallback',
      'stt.connections': 'fallback', 'stt.providers': 'fallback',
      'tts.connections': 'fallback', 'tts.providers': 'fallback',
      'imageGen.connections': 'fallback', 'imageGen.providers': 'fallback',
      'packs': 'fallback', 'personas': 'fallback', 'regexScripts': 'fallback',
      'council.settings': 'fallback', 'council.tools': 'fallback',
      'spindle': 'fallback',
    }
  }
  if (!isCurrent()) return

  if (payload) {
    const appliedRecentChats = applyBootstrap(payload, errors, {
      skipStartupSettings: useStore.getState().settingsLoaded,
      // The split landing bootstrap owns first-paint recent chats. Avoid
      // applying the full bootstrap's placeholder and racing the landing load.
      skipRecentChats: true,
      imageGenProfilesVersion,
    })
    if (appliedRecentChats) landingPreloadHandled = true

    if (
      !errors['personas']
      && payload.personas.total > payload.personas.data.length
    ) {
      personasApi.listAll()
        .then((personas) => {
          if (isCurrent()) useStore.getState().setPersonas(personas)
        })
        .catch(() => {})
    }
  }
  const settingsPromise = payload && !errors['startupSettings']
    ? loadFullSettings(isCurrent)
    : null
  if (Object.keys(errors).length > 0) await runFallbacks(errors, isCurrent)
  if (!isCurrent()) return

  await Promise.all([landingPromise, settingsPromise])
  if (!isCurrent()) return

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
        .then((data) => {
          if (isCurrent()) useStore.getState().setPackWithItems(packId, data)
        })
        .catch(() => {})
    }
  }
}

/** Fan the bootstrap payload into the store, skipping any section that
 *  the backend reported as failed (the fallback pass will retry those). */
export function applyLandingBootstrap(
  payload: LandingBootstrapPayload,
  errors: Record<string, string>,
  options: { skipRecentChats?: boolean } = {},
): boolean {
  const store = useStore.getState()
  const hadSettingsLoaded = store.settingsLoaded
  let appliedRecentChats = false

  if (!hadSettingsLoaded && !errors['startupSettings']) {
    store.hydrateStartupSettings(payload.startupSettings)
  }

  if (!options.skipRecentChats && !errors['recentChats'] && payload.recentChats) {
    store.setLandingRecentChats(payload.recentChats)
    appliedRecentChats = true
  }

  return appliedRecentChats
}

export function applyBootstrap(
  payload: BootstrapPayload,
  errors: Record<string, string>,
  options: {
    skipStartupSettings?: boolean
    skipRecentChats?: boolean
    imageGenProfilesVersion?: number
  } = {},
): boolean {
  const store = useStore.getState()
  let appliedRecentChats = false

  if (!options.skipStartupSettings && !errors['startupSettings']) {
    store.hydrateStartupSettings(payload.startupSettings)
  }

  if (!errors['llm.connections']) store.setProfiles(payload.llm.connections.data)
  if (!errors['llm.providers']) store.setProviders(payload.llm.providers)

  if (payload.decision && !errors['decision.connections']) store.setDecisionProfiles(payload.decision.connections.data)
  if (payload.decision && !errors['decision.providers']) store.setDecisionProviders(payload.decision.providers)

  if (!errors['stt.connections']) store.setSttProfiles(payload.stt.connections.data)
  if (!errors['stt.providers']) store.setSttProviders(payload.stt.providers)

  if (!errors['tts.connections']) store.setTtsProfiles(payload.tts.connections.data)
  if (!errors['tts.providers']) store.setTtsProviders(payload.tts.providers)

  if (!errors['imageGen.connections']) {
    store.setImageGenProfiles(payload.imageGen.connections.data, options.imageGenProfilesVersion)
  }
  if (!errors['imageGen.providers']) store.setImageGenProviders(payload.imageGen.providers)

  if (!errors['packs']) store.setPacks(payload.packs.data)
  if (!errors['personas'] && payload.personas.data.length >= payload.personas.total) {
    store.setPersonas(payload.personas.data)
  }
  if (!errors['regexScripts']) store.setRegexScripts(payload.regexScripts.data)

  // Landing page preload — no fallback needed: when absent, the landing page
  // falls back to its own recent-grouped fetch.
  if (!options.skipRecentChats && !errors['recentChats'] && payload.recentChats) {
    store.setLandingRecentChats(payload.recentChats)
    appliedRecentChats = true
  }

  if (!errors['council.settings']) {
    // Mirror the normalization from council.slice.ts:loadCouncilSettings —
    // merge in defaults so missing keys don't surface as `undefined`.
    const storedTools = payload.council.settings?.toolsSettings ?? {}
    store.setCouncilSettings({
      ...COUNCIL_SETTINGS_DEFAULTS,
      ...payload.council.settings,
      toolsSettings: { ...COUNCIL_TOOLS_DEFAULTS, ...storedTools },
    })
    store.setCouncilPersistenceTarget({ type: 'global' })
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

  return appliedRecentChats
}

/** Fill in sections the bootstrap payload couldn't provide by calling the
 *  original per-endpoint APIs. Each fallback is fire-and-forget so one
 *  failing section can't block the others. */
async function runFallbacks(
  errors: Record<string, string>,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return
  const store = useStore.getState()
  const fullSettingsPromise = errors['startupSettings']
    ? loadFullSettings(isCurrent)
    : null

  if (errors['llm.connections'] || errors['llm.providers']) {
    Promise.allSettled([
      listAllConnections(connectionsApi),
      connectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (!isCurrent()) return
      if (profilesRes.status === 'fulfilled') store.setProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setProviders(providersRes.value.providers)
    })
  }

  if (errors['decision.connections'] || errors['decision.providers']) {
    Promise.allSettled([listAllConnections(decisionConnectionsApi), decisionConnectionsApi.providers()]).then(([profilesRes, providersRes]) => {
      if (!isCurrent()) return
      if (profilesRes.status === 'fulfilled') store.setDecisionProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setDecisionProviders(providersRes.value.providers)
    })
  }

  if (errors['stt.connections'] || errors['stt.providers']) {
    Promise.allSettled([
      listAllConnections(sttConnectionsApi),
      sttConnectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (!isCurrent()) return
      if (profilesRes.status === 'fulfilled') store.setSttProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setSttProviders(providersRes.value.providers)
    })
  }

  if (errors['tts.connections'] || errors['tts.providers']) {
    Promise.allSettled([
      listAllConnections(ttsConnectionsApi),
      ttsConnectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (!isCurrent()) return
      if (profilesRes.status === 'fulfilled') store.setTtsProfiles(profilesRes.value.data)
      if (providersRes.status === 'fulfilled') store.setTtsProviders(providersRes.value.providers)
    })
  }

  if (errors['imageGen.connections'] || errors['imageGen.providers']) {
    const imageGenProfilesVersion = store.imageGenProfilesVersion
    Promise.allSettled([
      listAllConnections(imageGenConnectionsApi),
      imageGenConnectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (!isCurrent()) return
      if (profilesRes.status === 'fulfilled') {
        store.setImageGenProfiles(profilesRes.value.data, imageGenProfilesVersion)
      }
      if (providersRes.status === 'fulfilled') store.setImageGenProviders(providersRes.value.providers)
    })
  }

  if (errors['packs']) {
    packsApi.list({ limit: 200 })
      .then((res) => {
        if (isCurrent()) store.setPacks(res.data)
      })
      .catch(() => {})
  }

  if (errors['personas']) {
    personasApi.listAll()
      .then((personas) => {
        if (isCurrent()) store.setPersonas(personas)
      })
      .catch(() => {})
  }

  if (errors['regexScripts']) {
    store.loadRegexScripts(isCurrent).catch(() => {})
  }

  if (errors['council.settings']) {
    await store.loadCouncilSettings(isCurrent).catch(() => {})
    if (!isCurrent()) return
  }

  if (errors['council.tools'] || errors['spindle']) {
    await store.loadAvailableTools(isCurrent)
    if (!isCurrent()) return
  }

  if (fullSettingsPromise) await fullSettingsPromise
}
