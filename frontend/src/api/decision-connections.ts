import { get, post, put, del } from './client'
import type {
  DecisionConnectionProfile,
  CreateDecisionConnectionInput,
  UpdateDecisionConnectionInput,
  DecisionConnectionTestResult,
  DecisionConnectionModelsResult,
  DecisionProviderInfo,
  PaginatedResult,
} from '@/types/api'

export const decisionConnectionsApi = {
  initiateAuth(provider: 'openrouter' | 'nanogpt', callbackUrl: string, target: { connection_id: string } | { connection: CreateDecisionConnectionInput }) {
    return post<{ auth_url: string; session_token: string }>(`/decision-connections/auth/${provider}`, { callback_url: callbackUrl, ...target })
  },

  completeAuth(sessionToken: string, code: string) {
    return post<{ success: boolean; connection_id: string; created: boolean; profile: DecisionConnectionProfile }>('/decision-connections/auth/callback', {
      session_token: sessionToken, code,
    })
  },

  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<DecisionConnectionProfile>>('/decision-connections', params)
  },

  get(id: string) {
    return get<DecisionConnectionProfile>(`/decision-connections/${id}`)
  },

  create(input: CreateDecisionConnectionInput) {
    return post<DecisionConnectionProfile>('/decision-connections', input)
  },

  update(id: string, input: UpdateDecisionConnectionInput) {
    return put<DecisionConnectionProfile>(`/decision-connections/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/decision-connections/${id}`)
  },

  duplicate(id: string) {
    return post<DecisionConnectionProfile>(`/decision-connections/${id}/duplicate`)
  },

  test(id: string) {
    return post<DecisionConnectionTestResult>(`/decision-connections/${id}/test`)
  },

  sample(id: string) {
    return post<DecisionConnectionTestResult>(`/decision-connections/${id}/sample`, undefined, { timeout: 35_000 })
  },

  models(id: string) {
    return get<DecisionConnectionModelsResult>(`/decision-connections/${id}/models`)
  },

  previewModels(input: { connection_id?: string; provider: string; api_url?: string; api_key?: string }) {
    return post<DecisionConnectionModelsResult>('/decision-connections/models/preview', input)
  },

  setApiKey(id: string, apiKey: string) {
    return put<{ success: boolean }>(`/decision-connections/${id}/api-key`, { api_key: apiKey })
  },

  clearApiKey(id: string) {
    return del<{ success: boolean }>(`/decision-connections/${id}/api-key`)
  },

  providers() {
    return get<{ providers: DecisionProviderInfo[] }>('/decision-connections/providers')
  },
}
