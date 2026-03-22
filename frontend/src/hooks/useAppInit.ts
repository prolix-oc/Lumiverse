import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import { personasApi } from '@/api/personas'
import { packsApi } from '@/api/packs'

/**
 * Eagerly load shared data that multiple panels depend on.
 * Runs once after authentication succeeds.
 *
 * Without this, connection profiles and packs only load when their
 * respective panels mount, leaving other panels (e.g. Council) empty.
 */
export function useAppInit() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const didInit = useRef(false)

  useEffect(() => {
    if (!isAuthenticated || didInit.current) return
    didInit.current = true

    const store = useStore.getState()

    // Connection profiles + providers
    Promise.allSettled([
      connectionsApi.list({ limit: 100 }),
      connectionsApi.providers(),
    ]).then(([profilesRes, providersRes]) => {
      if (profilesRes.status === 'fulfilled') {
        store.setProfiles(profilesRes.value.data)
      }
      if (providersRes.status === 'fulfilled') {
        store.setProviders(providersRes.value.providers)
      }
    })

    // Packs
    packsApi.list({ limit: 200 }).then((res) => {
      store.setPacks(res.data)
    }).catch(() => {})

    // Personas
    personasApi.list({ limit: 200 }).then((res) => {
      store.setPersonas(res.data)
    }).catch(() => {})

    // Council settings + tools
    store.loadCouncilSettings()
    store.loadAvailableTools()
  }, [isAuthenticated])
}
