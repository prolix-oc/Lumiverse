import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const isAuthLoading = useStore((s) => s.isAuthLoading)
  const checkSession = useStore((s) => s.checkSession)
  const navigate = useNavigate()

  useEffect(() => {
    // Only verify session on cold load — skip if we just logged in
    if (!isAuthenticated) {
      checkSession()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
