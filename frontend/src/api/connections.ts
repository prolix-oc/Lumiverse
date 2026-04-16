import { get, post, put, del } from './client'
import type {
  ConnectionProfile, CreateConnectionProfileInput, UpdateConnectionProfileInput,
  PaginatedResult, ConnectionTestResult, ConnectionModelsResult, ProviderInfo,
  PollinationsAuthUrlRequest, PollinationsAuthUrlResponse,
} from '@/types/api'

export const connectionsApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<ConnectionProfile>>('/connections', params)
  },

  get(id: string) {
    return get<ConnectionProfile>(`/connections/${id}`)
  },

  create(input: CreateConnectionProfileInput) {
    return post<ConnectionProfile>('/connections', input)
  },

  update(id: string, input: UpdateConnectionProfileInput) {
    return put<ConnectionProfile>(`/connections/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/connections/${id}`)
  },

  duplicate(id: string) {
    return post<ConnectionProfile>(`/connections/${id}/duplicate`)
  },

  test(id: string) {
    return post<ConnectionTestResult>(`/connections/${id}/test`)
  },

  models(id: string) {
    return get<ConnectionModelsResult>(`/connections/${id}/models`)
  },

  pollinationsAuthUrl(input: PollinationsAuthUrlRequest) {
    return post<PollinationsAuthUrlResponse>('/connections/pollinations/auth-url', input)
  },

  providers() {
    return get<{ providers: ProviderInfo[] }>('/providers')
  },
}
