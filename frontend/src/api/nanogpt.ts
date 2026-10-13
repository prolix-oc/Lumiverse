import { get, post } from './client'
import type { NanoGptSubscriptionUsage } from '@/types/api'

export interface NanoGptProviderRouting {
  order?: string[]
  only?: string[]
  ignore?: string[]
  sort?: 'speed' | 'throughput' | 'latency' | 'price' | 'auto' | 'none' | 'default'
  allow_fallbacks?: boolean
  require_parameters?: boolean
  quantizations?: string[]
  min_quantization?: string
  max_price?: { prompt?: number; completion?: number }
}

export interface NanoGptConnectionSettings {
  billing_mode?: 'paygo'
  model_overrides?: Record<string, NanoGptProviderRouting>
}

export interface NanoGptTokenPricing {
  inputPer1kTokens?: number
  outputPer1kTokens?: number
}

export interface NanoGptModelProviders {
  canonicalId: string
  displayName: string
  supportsProviderSelection: boolean
  defaultPrice?: NanoGptTokenPricing
  providers: {
    provider: string
    displayName?: string
    available: boolean
    pricing?: NanoGptTokenPricing
    effectivePricing?: { effective_price?: NanoGptTokenPricing }
    quantization?: string
  }[]
}

export interface NanoGptAccountUsage {
  subscription: NanoGptSubscriptionUsage | null
  balance: { usd_balance: number | null; nano_balance: number | null } | null
  paygo: {
    from: string
    to: string
    asOf: string | null
    usage_daily: number
    usage_monthly: number
    requests: number
    inputTokens: number
    outputTokens: number
  } | null
  errors: Partial<Record<'subscription' | 'balance' | 'paygo', string>>
}

export interface NanoGptAuthResult {
  auth_url: string
  session_token: string
}

export interface NanoGptCompleteAuthResult {
  success: boolean
  connection_id: string
  created?: boolean
  profile?: import('@/types/api').ConnectionProfile
}

export function buildNanoGptOAuthCallbackUrl(): string {
  const url = new URL('/api/v1/nanogpt/oauth-landing', window.location.origin)
  url.searchParams.set('opener_origin', window.location.origin)
  return url.toString()
}

export const nanoGptApi = {
  account(connectionId: string) {
    return get<NanoGptAccountUsage>('/nanogpt/account', { connection_id: connectionId })
  },

  providers(input: { connection_id?: string; api_url?: string; api_key?: string; model: string }) {
    return post<NanoGptModelProviders>('/nanogpt/providers/preview', input)
  },

  initiateAuth(callbackUrl: string, opts: { connectionId?: string; connectionName?: string }) {
    const params: Record<string, string> = { callback_url: callbackUrl }
    if (opts.connectionId) params.connection_id = opts.connectionId
    else if (opts.connectionName) params.connection_name = opts.connectionName
    return get<NanoGptAuthResult>('/nanogpt/auth', params)
  },

  completeAuth(sessionToken: string, code: string) {
    return post<NanoGptCompleteAuthResult>('/nanogpt/auth/callback', {
      session_token: sessionToken,
      code,
    })
  },
}
