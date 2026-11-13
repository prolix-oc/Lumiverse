import { useCallback, useEffect, useRef, useState } from 'react'
import { openrouterApi, type OpenRouterCreditsInfo } from '@/api/openrouter'
import { nanoGptApi, type NanoGptAccountUsage } from '@/api/nanogpt'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type { ConnectionProfile, NanoGptSubscriptionUsage } from '@/types/api'

interface AccountState {
  key: string
  loading: boolean
  credits: OpenRouterCreditsInfo | null
  nanoGptAccount: NanoGptAccountUsage | null
  nanoGptUsage: NanoGptSubscriptionUsage | null
  error: string | null
}

const EMPTY_ACCOUNT: AccountState = { key: '', loading: false, credits: null, nanoGptAccount: null, nanoGptUsage: null, error: null }
type AccountProfile = Pick<ConnectionProfile, 'id' | 'provider' | 'has_api_key' | 'updated_at'>

/** The manager owns account reads; every placement of its active row shares this state. */
export function useConnectionAccount(profile: AccountProfile | undefined, kind: 'llm' | 'imageGen' = 'llm') {
  const id = profile?.id
  const provider = profile?.provider
  const supported = profile?.has_api_key && (provider === 'nanogpt' || (kind === 'llm' && provider === 'openrouter'))
  const key = supported ? JSON.stringify([kind, id, provider, profile?.updated_at]) : ''
  const [state, setState] = useState(EMPTY_ACCOUNT)
  const requests = useRef({ generation: 0 })

  const refresh = useCallback(async () => {
    const request = ++requests.current.generation
    if (!key || !id) return
    setState(current => ({ ...(current.key === key ? current : EMPTY_ACCOUNT), key, loading: true, error: null }))
    try {
      const credits = provider === 'openrouter' ? await openrouterApi.credits(id) : null
      const nanoGptAccount = provider === 'nanogpt' && kind === 'llm' ? await nanoGptApi.account(id) : null
      const nanoGptUsage = kind === 'imageGen' ? await imageGenConnectionsApi.nanogptUsage(id) : null
      if (requests.current.generation === request) setState({ key, credits, nanoGptAccount, nanoGptUsage, loading: false, error: null })
    } catch (error) {
      if (requests.current.generation !== request) return
      const failure = error as { body?: { error?: string }; message?: string }
      setState(current => ({ ...current, credits: null, nanoGptUsage: null, loading: false, error: failure?.body?.error || failure?.message || '' }))
    }
  }, [id, provider, key, kind])

  useEffect(() => {
    void refresh()
    const pending = requests.current
    return () => { pending.generation++ }
  }, [refresh])

  return { ...(state.key === key ? state : EMPTY_ACCOUNT), refresh }
}

export type ConnectionAccount = ReturnType<typeof useConnectionAccount>
