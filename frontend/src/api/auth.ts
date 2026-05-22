import { createAuthClient } from 'better-auth/react'
import { usernameClient, adminClient } from 'better-auth/client/plugins'

type AuthClientErrorLike = {
  message?: string
  status?: number
  statusText?: string
  code?: string
}

type AuthErrorContext = 'login' | 'session'

export type AuthErrorResponseMeta = {
  retryAfterSeconds?: number
  lockedUntil?: string
  reason?: string
  serverMessage?: string
}

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [usernameClient(), adminClient()],
})

export const { signIn, signOut, signUp, useSession } = authClient

function isAuthClientErrorLike(value: unknown): value is AuthClientErrorLike {
  return !!value && typeof value === 'object'
}

function looksLikeNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message)
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(totalSeconds))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`

  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`

  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`

  const days = Math.ceil(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

function formatLockoutMessage(context: AuthErrorContext, meta?: AuthErrorResponseMeta): string {
  const wait = meta?.retryAfterSeconds ? formatDuration(meta.retryAfterSeconds) : 'a while'
  if (context === 'session') {
    return `This client is temporarily locked out. Try again in ${wait}.`
  }
  return `Too many failed sign-in attempts. Try again in ${wait}.`
}

function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export async function readAuthErrorResponseMeta(context: unknown): Promise<AuthErrorResponseMeta | null> {
  const response = (context as { response?: Response } | null | undefined)?.response
  if (!(response instanceof Response)) return null

  let body: any = null
  try {
    body = await response.clone().json()
  } catch {
    body = null
  }

  const retryAfterSeconds =
    (typeof body?.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0 ? body.retryAfterSeconds : undefined) ??
    parseRetryAfterSeconds(response.headers.get('retry-after')) ??
    parseRetryAfterSeconds(response.headers.get('x-retry-after'))

  return {
    retryAfterSeconds,
    lockedUntil: typeof body?.lockedUntil === 'string' ? body.lockedUntil : undefined,
    reason: typeof body?.reason === 'string' ? body.reason : undefined,
    serverMessage: typeof body?.error === 'string' ? body.error.trim() : undefined,
  }
}

function fallbackMessage(context: AuthErrorContext): string {
  return context === 'session'
    ? 'Could not verify your session. Check that the backend is running, then try again.'
    : 'Sign-in failed. Please try again.'
}

export function getAuthErrorMessage(
  error: unknown,
  context: AuthErrorContext = 'login',
  responseMeta?: AuthErrorResponseMeta | null,
): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return context === 'session'
      ? 'Session verification was interrupted. Please refresh and try again.'
      : 'Sign-in was interrupted. Please try again.'
  }

  if (error instanceof TypeError && looksLikeNetworkError(error.message)) {
    return context === 'session'
      ? 'Could not reach the backend to verify your session. Check that the server is running.'
      : 'Could not reach the backend. Check that the server is running, then try again.'
  }

  if (isAuthClientErrorLike(error)) {
    const status = error.status
    const code = error.code?.toUpperCase()
    const message = (error.message || '').trim()

    if (
      status === 401 ||
      code === 'INVALID_EMAIL_OR_PASSWORD' ||
      code === 'INVALID_USERNAME_OR_PASSWORD'
    ) {
      return 'Invalid username or password.'
    }

    if (status === 429) {
      return formatLockoutMessage(context, responseMeta ?? undefined)
    }

    if (status === 403) {
      return context === 'session'
        ? 'This browser is not allowed to access the backend from the current address.'
        : 'This browser is not allowed to sign in to the backend from the current address.'
    }

    if (status !== undefined && status >= 500) {
      return context === 'session'
        ? 'The backend hit an error while checking your session. Try again in a moment.'
        : 'The backend hit an error while signing you in. Try again in a moment.'
    }

    if (looksLikeNetworkError(message)) {
      return context === 'session'
        ? 'Could not reach the backend to verify your session. Check that the server is running.'
        : 'Could not reach the backend. Check that the server is running, then try again.'
    }

    if (message) {
      return message
    }
  }

  if (error instanceof Error) {
    if (looksLikeNetworkError(error.message)) {
      return context === 'session'
        ? 'Could not reach the backend to verify your session. Check that the server is running.'
        : 'Could not reach the backend. Check that the server is running, then try again.'
    }
    if (error.message.trim()) {
      return error.message
    }
  }

  return fallbackMessage(context)
}
