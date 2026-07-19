import { get, post } from './client'

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
