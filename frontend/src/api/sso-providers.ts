import { del, get, post, put } from './client'

export type SsoProviderKind = 'authelia' | 'authentik' | 'keycloak' | 'custom_oidc'

export interface SsoProvider {
  id: string
  provider_kind: SsoProviderKind
  name: string
  slug: string
  enabled: boolean
  issuer_url: string
  discovery_url: string
  client_id: string
  has_client_secret: boolean
  scopes: string[]
  pkce: boolean
  allow_signup: boolean
  metadata: Record<string, unknown>
  redirect_uri: string
  active_redirect_uri: string | null
  active: boolean
  requires_restart: boolean
  created_at: number
  updated_at: number
}

export interface SsoProviderInput {
  provider_kind: SsoProviderKind
  name: string
  slug: string
  enabled: boolean
  issuer_url: string
  discovery_url?: string
  redirect_origin?: string
  client_id: string
  client_secret?: string
  scopes: string[]
  pkce: boolean
  allow_signup: boolean
  metadata?: Record<string, unknown>
}

export interface SsoDiscoveryResult {
  ok: boolean
  issuer?: string
  authorization_endpoint?: string
  token_endpoint?: string
  userinfo_endpoint?: string
  jwks_uri?: string
  scopes_supported?: string[]
  error?: string
}

export interface SsoLoginOption {
  provider_id: string
  provider_kind: SsoProviderKind
  name: string
}

export interface SsoUserLink {
  user_id: string
  username: string | null
  email: string | null
  name: string | null
  role: string | null
  provider_id: string
  provider_name: string
  provider_kind: SsoProviderKind
  account_id: string
  linked_at: number | null
  updated_at: number | null
}

export interface SsoRecoveryStatus {
  owner_count: number
  owner_credential_count: number
  owner_sso_link_count: number
  password_login_enabled: boolean
  can_recover: boolean
}

export interface SsoLinksResponse {
  current_user_links: SsoUserLink[]
  all_links: SsoUserLink[]
  recovery: SsoRecoveryStatus
}

async function authPost<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let parsed: any = null
    try { parsed = await res.json() } catch {}
    throw new Error(parsed?.message || parsed?.error || `Auth request failed (${res.status})`)
  }
  return res.json()
}

export const ssoProvidersApi = {
  list() {
    return get<SsoProvider[]>('/sso-providers')
  },
  create(input: SsoProviderInput) {
    return post<SsoProvider>('/sso-providers', input)
  },
  update(id: string, input: Partial<SsoProviderInput>) {
    return put<SsoProvider>(`/sso-providers/${encodeURIComponent(id)}`, input)
  },
  delete(id: string) {
    return del<{ success: boolean }>(`/sso-providers/${encodeURIComponent(id)}`)
  },
  testDiscovery(input: { issuer_url: string; discovery_url?: string }) {
    return post<SsoDiscoveryResult>('/sso-providers/test-discovery', input, { timeout: 10_000 })
  },
  loginOptions() {
    return get<SsoLoginOption[]>('/sso-providers/login-options')
  },
  links() {
    return get<SsoLinksResponse>('/sso-providers/links')
  },
  unlinkCurrentUser(providerId: string) {
    return del<{ success: boolean; recovery: SsoRecoveryStatus }>(`/sso-providers/links/${encodeURIComponent(providerId)}`)
  },
  getLoginUrl(providerId: string, callbackURL = '/') {
    return authPost<{ url: string; redirect: boolean }>('/sign-in/oauth2', { providerId, callbackURL, disableRedirect: true })
  },
  getLinkUrl(providerId: string, callbackURL = '/sso-complete') {
    return authPost<{ url: string; redirect: boolean }>('/oauth2/link', { providerId, callbackURL })
  },
}
