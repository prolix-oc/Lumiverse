export const AUTH_SESSION_INVALID_EVENT = 'lumiverse:auth-session-invalid'

export function isExpiredSessionResponse(status: number, body: unknown): boolean {
  return status === 401
    && !!body
    && typeof body === 'object'
    && (body as { code?: unknown }).code === 'SESSION_EXPIRED'
}

/** Tell the mounted auth guard that an API request reached the backend without
 * a valid session. The guard owns the authoritative session re-check so the
 * request layer stays independent from the Zustand store. */
export function signalInvalidAuthSession(): void {
  window.dispatchEvent(new Event(AUTH_SESSION_INVALID_EVENT))
}
