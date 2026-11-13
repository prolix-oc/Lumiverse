import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { AUTH_SESSION_INVALID_EVENT } from '@/api/session-lifecycle'
import { useAndroidPushSync } from '@/hooks/useAndroidPushSync'

const SESSION_REVALIDATION_INTERVAL_MS = 15 * 60 * 1000

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const isAuthLoading = useStore((s) => s.isAuthLoading)
  const checkSession = useStore((s) => s.checkSession)
  const navigate = useNavigate()
  useAndroidPushSync(useStore(s => s.isAuthenticated ? s.user?.id ?? null : s.isAuthLoading ? undefined : null))

  useEffect(() => {
    // Only verify session on cold load — skip if we just logged in
    if (!isAuthenticated) {
      checkSession()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAuthenticated) return

    let validationInFlight = false
    const revalidate = () => {
      if (document.visibilityState !== 'visible') return
      if (validationInFlight) return
      validationInFlight = true
      void checkSession().finally(() => {
        validationInFlight = false
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') revalidate()
    }

    // Keep an active desktop session sliding, recover immediately after a
    // suspended/mobile tab returns, and reconcile the store as soon as any API
    // call reports that the server no longer accepts the session.
    const interval = window.setInterval(revalidate, SESSION_REVALIDATION_INTERVAL_MS)
    window.addEventListener('online', revalidate)
    window.addEventListener(AUTH_SESSION_INVALID_EVENT, revalidate)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('online', revalidate)
      window.removeEventListener(AUTH_SESSION_INVALID_EVENT, revalidate)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [checkSession, isAuthenticated])

  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      navigate('/login')
    }
  }, [isAuthLoading, isAuthenticated, navigate])

  if (isAuthLoading && !isAuthenticated) {
    return null
  }

  if (!isAuthenticated) {
    return null
  }

  return <>{children}</>
}
