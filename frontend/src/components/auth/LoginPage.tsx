import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { motion, LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { ssoProvidersApi, type SsoLoginOption } from '@/api/sso-providers'
import { startSsoPopup } from '@/lib/ssoPopup'
import styles from './LoginPage.module.css'
import clsx from 'clsx'

export default function LoginPage() {
  const { t } = useTranslation('auth')
  const { t: tc } = useTranslation('common')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [ssoLoading, setSsoLoading] = useState<string | null>(null)
  const [ssoOptions, setSsoOptions] = useState<SsoLoginOption[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [subtitleKey] = useState<'subtitleGoon' | 'subtitleLoom'>(() =>
    Math.random() < 0.076 ? 'subtitleGoon' : 'subtitleLoom',
  )
  const login = useStore((s) => s.login)
  const authError = useStore((s) => s.authError)
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const isAuthLoading = useStore((s) => s.isAuthLoading)
  const checkSession = useStore((s) => s.checkSession)
  const navigate = useNavigate()
  const formRef = useRef<HTMLFormElement>(null)
  const visibleError = error ?? authError

  useEffect(() => {
    let cancelled = false
    ssoProvidersApi.loginOptions()
      .then((options) => { if (!cancelled) setSsoOptions(options) })
      .catch(() => { if (!cancelled) setSsoOptions([]) })
    return () => { cancelled = true }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      await login(username, password)
      navigate('/')
    } catch (err: any) {
      setError(err.message || t('loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleSsoSignIn = async (provider: SsoLoginOption) => {
    setError(null)
    setSsoLoading(provider.provider_id)
    try {
      const result = await startSsoPopup({ providerId: provider.provider_id, flow: 'login', returnTo: '/' })
      if (!result.ok) throw new Error(result.error || 'SSO authorization failed')
      await checkSession()
      navigate('/')
    } catch (err: any) {
      setError(err.message || `Failed to start ${provider.name} sign-in`)
      setSsoLoading(null)
    }
  }

  useEffect(() => {
    if (!isAuthenticated) {
      checkSession()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true })
    }
  }, [isAuthenticated, navigate])

  useEffect(() => {
    if (!focused) return
    const scrollFocusedInput = () => {
      formRef.current?.querySelector(`#${focused}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }
    const timers = [100, 350, 650].map((delay) => setTimeout(scrollFocusedInput, delay))
    window.visualViewport?.addEventListener('resize', scrollFocusedInput)

    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      window.visualViewport?.removeEventListener('resize', scrollFocusedInput)
    }
  }, [focused])

  if (isAuthLoading || isAuthenticated) {
    return (
      <div className={styles.checking} role="status" aria-live="polite" aria-busy="true">
        <div className={styles.checkingSpinner} aria-label={t('checkingSession')} />
      </div>
    )
  }

  return (
    <LazyMotion features={domAnimation} strict={false}>
    <MotionConfig reducedMotion="user">
    <div className={styles.page}>
      <div className={styles.bg}>
        <div className={clsx(styles.bgGlow, styles.bgGlow1)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow2)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow3)} />
      </div>

      <div className={styles.grid} />

      <div className={styles.content}>
        <motion.div
          className={styles.logoBlock}
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.logoIcon}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="36" height="36">
              <g transform="rotate(-12, 32, 32)">
                <ellipse cx="32" cy="12" rx="18" ry="6" fill="#8B5A2B" />
                <ellipse cx="32" cy="12" rx="14" ry="4" fill="#A0522D" />
                <rect x="14" y="12" width="36" height="40" fill="#8B5FC7" />
                <line x1="14" y1="18" x2="50" y2="18" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="24" x2="50" y2="24" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="30" x2="50" y2="30" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="36" x2="50" y2="36" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="42" x2="50" y2="42" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="48" x2="50" y2="48" stroke="#7A4EB8" strokeWidth="1.5" />
                <rect x="14" y="12" width="8" height="40" fill="#A78BD4" opacity="0.5" />
                <ellipse cx="32" cy="52" rx="18" ry="6" fill="#8B5A2B" />
                <rect x="14" y="48" width="36" height="4" fill="#8B5FC7" />
                <ellipse cx="32" cy="52" rx="14" ry="4" fill="#A0522D" />
                <ellipse cx="32" cy="52" rx="5" ry="2" fill="#5D3A1A" />
                <path d="M 48 35 Q 55 38 52 45 Q 49 52 56 58" fill="none" stroke="#8B5FC7" strokeWidth="2" strokeLinecap="round" />
              </g>
            </svg>
          </div>
          <h1 className={styles.logoTitle}>{tc('appName')}</h1>
          <p className={styles.logoSubtitle}>{t(subtitleKey)}</p>
        </motion.div>

        <motion.div
          className={styles.card}
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.cardHighlight} />

          <form ref={formRef} className={styles.form} onSubmit={handleSubmit}>
            <motion.div
              className={styles.field}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.3 }}
            >
              <label className={styles.label} htmlFor="username">{t('username')}</label>
              <div className={clsx(styles.inputWrap, focused === 'username' && styles.inputWrapFocused)}>
                <input
                  id="username"
                  name="username"
                  className={clsx(styles.input, styles.inputLowercase)}
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  onFocus={() => setFocused('username')}
                  onBlur={() => setFocused(null)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                  spellCheck={false}
                  enterKeyHint="next"
                  placeholder={t('usernamePlaceholder')}
                />
              </div>
            </motion.div>

            <motion.div
              className={styles.field}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.4 }}
            >
              <label className={styles.label} htmlFor="password">{t('password')}</label>
              <div className={clsx(styles.inputWrap, focused === 'password' && styles.inputWrapFocused)}>
                <input
                  id="password"
                  name="password"
                  className={styles.input}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  enterKeyHint="done"
                  placeholder={t('passwordPlaceholder')}
                />
              </div>
            </motion.div>

            {visibleError && (
              <motion.div
                className={styles.error}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.2 }}
              >
                <div className={styles.errorInner}>{visibleError}</div>
              </motion.div>
            )}

            <motion.button
              type="submit"
              className={styles.submitBtn}
              disabled={loading || !username || !password}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.5 }}
              whileHover={{ scale: 1.015 }}
              whileTap={{ scale: 0.985 }}
            >
              {loading ? (
                <span className={styles.loadingState}>
                  <span className={styles.spinner} />
                  {t('signingIn')}
                </span>
              ) : (
                t('signIn')
              )}
            </motion.button>

            {ssoOptions.length > 0 && (
              <motion.div
                className={styles.ssoBlock}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.58 }}
              >
                <div className={styles.ssoDivider}><span>or</span></div>
                <div className={styles.ssoList}>
                  {ssoOptions.map((provider) => (
                    <button
                      key={provider.provider_id}
                      type="button"
                      className={styles.ssoBtn}
                      disabled={!!ssoLoading}
                      onClick={() => handleSsoSignIn(provider)}
                    >
                      {ssoLoading === provider.provider_id ? (
                        <span className={styles.loadingState}><span className={styles.spinner} />Redirecting</span>
                      ) : (
                        `Continue with ${provider.name}`
                      )}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </form>
        </motion.div>

        <motion.p
          className={styles.footer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.7 }}
        >
          {t('footer')}
        </motion.p>
      </div>
    </div>
    </MotionConfig>
    </LazyMotion>
  )
}
