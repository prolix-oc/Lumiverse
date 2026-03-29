import { get, post } from './client'

export interface OpenRouterCreditsInfo {
  label: string | null
  limit: number | null
  limit_remaining: number | null
  limit_reset: string | null
  usage: number
  usage_daily: number
  usage_weekly: number
  usage_monthly: number
  is_free_tier: boolean
}

export interface OpenRouterModelInfo {
  id: string
  name: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
    request?: string
    image?: string
  }
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
    is_moderated?: boolean
  }
  architecture?: {
    tokenizer?: string
    instruct_type?: string
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: string[]
}

export interface OpenRouterAuthResult {
  auth_url: string
  session_token: string
}

export interface OpenRouterProviderRouting {
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
  data_collection?: 'allow' | 'deny'
  ignore?: string[]
  only?: string[]
  quantizations?: string[]
  sort?: string
}

export interface OpenRouterPlugin {
  id: string
  enabled?: boolean
  [key: string]: any
}

export interface OpenRouterConnectionSettings {
  provider_routing?: OpenRouterProviderRouting
  plugins?: OpenRouterPlugin[]
}

export interface OpenRouterProviderEntry {
  name: string
  slug: string
}

export const openrouterApi = {
  /** Initiate PKCE OAuth flow. Returns authorization URL + session token. */
  initiateAuth(connectionId: string, callbackUrl: string) {
    return get<OpenRouterAuthResult>('/openrouter/auth', { connection_id: connectionId, callback_url: callbackUrl })
  },

  /** Complete PKCE OAuth flow. Exchange code for API key. */
  completeAuth(sessionToken: string, code: string) {
    return post<{ success: boolean; connection_id: string }>('/openrouter/auth/callback', {
      session_token: sessionToken,
      code,
    })
  },

  /** Get credit balance and usage stats for an OpenRouter connection. */
  credits(connectionId: string) {
    return get<OpenRouterCreditsInfo>(`/openrouter/credits/${connectionId}`)
  },

  /** Get rich model metadata (pricing, context length, capabilities). */
  models(connectionId: string, params?: { search?: string; supported_parameter?: string }) {
    return get<{ models: OpenRouterModelInfo[]; total: number }>(`/openrouter/models/${connectionId}`, params)
  },

  /** Get generation stats for a specific generation ID. */
  generationStats(connectionId: string, generationId: string) {
    return get<any>(`/openrouter/generation/${connectionId}/${generationId}`)
  },

  /** Get list of upstream providers (for prefer/ignore dropdowns). */
  providers(connectionId: string) {
    return get<{ providers: OpenRouterProviderEntry[] }>(`/openrouter/providers/${connectionId}`)
  },
}
