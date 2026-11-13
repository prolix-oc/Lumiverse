import {
  closeAuthorizationPopup,
  navigateAuthorizationPopup,
  reserveAuthorizationPopup,
} from './authorizationPopup'

type OAuthProvider = 'openrouter' | 'nanogpt'

interface ProviderOAuthPopupOptions {
  provider: OAuthProvider
  callbackUrl: string
  initiate: () => Promise<{ auth_url: string; session_token: string }>
}

interface ProviderOAuthCode {
  sessionToken: string
  code: string
}

const CHANNEL_NAME = 'lumiverse:provider-oauth'
const STORAGE_PREFIX = 'lumiverse:provider-oauth:'

/** Reserve the popup during the click, then listen before navigating it.
 * Native WebViews can lose window.opener across provider redirects, so the
 * same-origin callback also publishes through a channel and temporary storage. */
export function startProviderOAuthPopup({ provider, callbackUrl, initiate }: ProviderOAuthPopupOptions): {
  result: Promise<ProviderOAuthCode | null>
  cancel: () => void
} {
  const popup = reserveAuthorizationPopup({
    name: `${provider}_auth`,
    features: 'popup=yes,width=600,height=700,scrollbars=yes,resizable=yes',
  })
  const callbackOrigin = new URL(callbackUrl).origin
  let cancel = () => {}

  const result = new Promise<ProviderOAuthCode | null>((resolve, reject) => {
    let settled = false
    let sessionToken: string | null = null
    let channel: BroadcastChannel | null = null
    let pollTimer: number | undefined
    let timeoutTimer: number | undefined
    let closedTimer: number | undefined

    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('storage', onStorage)
      channel?.close()
      window.clearInterval(pollTimer)
      window.clearTimeout(timeoutTimer)
      window.clearTimeout(closedTimer)
      if (sessionToken) {
        try { window.localStorage.removeItem(`${STORAGE_PREFIX}${sessionToken}`) } catch {}
      }
      closeAuthorizationPopup(popup)
    }

    const finish = (value: ProviderOAuthCode | null, error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    cancel = () => finish(null)

    const handlePayload = (payload: unknown) => {
      if (settled || !sessionToken || !payload || typeof payload !== 'object') return
      const message = payload as Record<string, unknown>
      if (message.type !== `${provider}_oauth_code` || message.state !== sessionToken) return
      if (typeof message.error === 'string' && message.error) {
        finish(null, new Error(`Authorization failed: ${message.error}`))
      } else if (typeof message.code === 'string' && message.code) {
        finish({ sessionToken, code: message.code })
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== callbackOrigin) return
      handlePayload(event.data)
    }

    function onStorage(event: StorageEvent) {
      if (callbackOrigin !== window.location.origin) return
      if (!sessionToken || event.key !== `${STORAGE_PREFIX}${sessionToken}` || !event.newValue) return
      try { handlePayload(JSON.parse(event.newValue)) } catch {}
    }

    const readCompletion = () => {
      if (!sessionToken || callbackOrigin !== window.location.origin) return
      try {
        const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${sessionToken}`)
        if (raw) handlePayload(JSON.parse(raw))
      } catch {}
    }

    if (!popup) {
      finish(null, new Error('Allow popups to sign in to this provider.'))
      return
    }

    window.addEventListener('message', onMessage)
    window.addEventListener('storage', onStorage)
    if (callbackOrigin === window.location.origin && 'BroadcastChannel' in window) {
      try {
        channel = new window.BroadcastChannel(CHANNEL_NAME)
        channel.onmessage = (event) => handlePayload(event.data)
      } catch {}
    }

    pollTimer = window.setInterval(() => {
      readCompletion()
      // Let an already-published callback arrive before treating a closed
      // native window as cancellation.
      if (!settled && popup.closed && closedTimer === undefined) {
        closedTimer = window.setTimeout(() => {
          readCompletion()
          finish(null)
        }, 1500)
      }
    }, 500)
    timeoutTimer = window.setTimeout(() => finish(null), 5 * 60 * 1000)

    Promise.resolve().then(initiate).then(({ auth_url, session_token }) => {
      if (settled) return
      sessionToken = session_token
      const navigation = navigateAuthorizationPopup(popup, auth_url, { preserveOpener: true })
      if (navigation.status !== 'popup') {
        finish(null, new Error(navigation.status === 'invalid'
          ? 'Provider returned an invalid authorization URL.'
          : 'Could not open the provider sign-in window.'))
      }
    }).catch((error) => {
      finish(null, error instanceof Error ? error : new Error('Failed to start provider authorization.'))
    })
  })

  return { result, cancel: () => cancel() }
}
