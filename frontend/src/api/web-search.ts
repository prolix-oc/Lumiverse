import { get, post, put } from './client'

export interface WebSearchProviderProfile {
  apiUrl: string
  requestTimeoutMs: number
  defaultResultCount: number
  maxResultCount: number
  maxPagesToScrape: number
  maxCharsPerPage: number
  language: string
  safeSearch: 0 | 1 | 2
  engines: string[]
  inlineToolEnabled: boolean
  hasApiKey?: boolean
}

export interface WebSearchSettingsInput {
  enabled?: boolean
  provider?: 'searxng' | 'exa' | 'tavily'
  apiUrl?: string
  requestTimeoutMs?: number
  defaultResultCount?: number
  maxResultCount?: number
  maxPagesToScrape?: number
  maxCharsPerPage?: number
  language?: string
  safeSearch?: 0 | 1 | 2
  engines?: string[]
  inlineToolEnabled?: boolean
  providerProfiles?: Partial<Record<'searxng' | 'exa' | 'tavily', WebSearchProviderProfile>>
  apiKey?: string | null
}

export interface WebSearchSettingsResponse {
  enabled: boolean
  provider: 'searxng' | 'exa' | 'tavily'
  apiUrl: string
  requestTimeoutMs: number
  defaultResultCount: number
  maxResultCount: number
  maxPagesToScrape: number
  maxCharsPerPage: number
  language: string
  safeSearch: 0 | 1 | 2
  engines: string[]
  inlineToolEnabled: boolean
  hasApiKey: boolean
  providerProfiles?: Partial<Record<'searxng' | 'exa' | 'tavily', WebSearchProviderProfile>>
}

export interface WebSearchDocument {
  title: string
  url: string
  snippet: string
  sourceType?: 'web' | 'wiki'
  content?: string
  contentLength?: number
  error?: string
}

export interface WebSearchTestResponse {
  query: string
  results: Array<{
    title: string
    url: string
    snippet: string
    engine?: string
    score?: number
  }>
  documents: WebSearchDocument[]
  context: string
}

export const webSearchApi = {
  getSettings() {
    return get<WebSearchSettingsResponse>('/web-search/settings')
  },
  putSettings(body: WebSearchSettingsInput) {
    return put<WebSearchSettingsResponse>('/web-search/settings', body)
  },
  test(query: string, settings?: WebSearchSettingsInput, apiKey?: string) {
    return post<WebSearchTestResponse>('/web-search/test', {
      query,
      settings,
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
    })
  },
}
