import { ssoProvidersApi } from '@/api/sso-providers'
import { uuidv4 } from '@/lib/uuid'
import { hasTauriDesktopBridge, isTauriMobile } from '@/lib/desktopWebView'
import { getSafeHttpOrHttpsUrl } from '@/lib/navigationSafety'
import {
  closeAuthorizationPopup,
  navigateAuthorizationPopup,
  reserveAuthorizationPopup,
} from '@/lib/authorizationPopup'

type SsoFlow = 'login' | 'link'

interface SsoPopupOptions {
  providerId: string
  flow: SsoFlow
  returnTo?: string
}

interface SsoPopupResult {
  flow: SsoFlow
  providerId: string
  flowId: string
  ok: boolean
  error?: string
}

const CHANNEL_NAME = 'lumiverse:sso'
const STORAGE_PREFIX = 'lumiverse:sso:'

function popupFeatures(): string {
  const width = Math.min(520, Math.max(360, Math.floor(window.screen.availWidth * 0.9)))
  const height = Math.min(760, Math.max(560, Math.floor(window.screen.availHeight * 0.86)))
  const left = Math.max(0, Math.floor((window.screen.availWidth - width) / 2))
  const top = Math.max(0, Math.floor((window.screen.availHeight - height) / 2))
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
}

function completionUrl(flow: SsoFlow, providerId: string, flowId: string, returnTo: string, redirect: boolean): string {
  const url = new URL('/sso-complete', window.location.origin)
  url.searchParams.set('flow', flow)
  url.searchParams.set('provider', providerId)
  url.searchParams.set('flowId', flowId)
  url.searchParams.set('returnTo', returnTo)
  if (redirect) url.searchParams.set('mode', 'redirect')
  return url.toString()
}

function usesSameWindowSso(): boolean {
  if (isTauriMobile() || hasTauriDesktopBridge()) return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  return ios && (nav.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.matchMedia?.('(display-mode: fullscreen)').matches === true)
}

function isResult(value: unknown, flowId: string): value is SsoPopupResult {
  return !!value && typeof value === 'object' && (value as SsoPopupResult).flowId === flowId
}

/** A null result means the current page is redirecting to the provider. */
export function startSsoPopup({ providerId, flow, returnTo = '/' }: SsoPopupOptions): Promise<SsoPopupResult | null> {
  const flowId = uuidv4()
  const redirect = usesSameWindowSso()
  const callbackURL = completionUrl(flow, providerId, flowId, returnTo, redirect)

  // Home Screen WebKit can lose or externalize a reserved popup. Keep the
  // authorization and callback in the PWA's own browsing context instead.
  if (redirect) {
    const starter = flow === 'login'
      ? ssoProvidersApi.getLoginUrl(providerId, callbackURL)
      : ssoProvidersApi.getLinkUrl(providerId, callbackURL)
    return starter.then(({ url }) => {
      const target = getSafeHttpOrHttpsUrl(url)
      if (!target) throw new Error('SSO provider returned an invalid authorization URL.')
      window.location.assign(target)
      return null
    })
  }

  const popup = reserveAuthorizationPopup({
    name: `lumiverse_sso_${flow}_${providerId}`,
    features: popupFeatures(),
  })
  const storageKey = `${STORAGE_PREFIX}${flowId}`

  return new Promise((resolve, reject) => {
    let settled = false
    let channel: BroadcastChannel | null = null
    let pollTimer: number | null = null
    let timeoutTimer: number | null = null

    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('storage', onStorage)
      channel?.close()
      if (pollTimer) window.clearInterval(pollTimer)
      if (timeoutTimer) window.clearTimeout(timeoutTimer)
      try { window.localStorage.removeItem(storageKey) } catch {}
    }

    const finish = (result: SsoPopupResult) => {
      if (settled) return
      settled = true
      cleanup()
      // The desktop shell creates window.open targets as native WebviewWindows.
      // Closing from the opener is the most reliable cross-platform lifecycle
      // signal and also keeps the browser implementation symmetrical with the
      // cancellation/error path below.
      closeAuthorizationPopup(popup)
      resolve(result)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      closeAuthorizationPopup(popup)
      reject(error)
    }

    const handlePayload = (payload: unknown) => {
      if (isResult(payload, flowId)) finish(payload)
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== 'lumiverse:sso-complete') return
      handlePayload(event.data.payload)
    }

    function onStorage(event: StorageEvent) {
      if (event.key !== storageKey || !event.newValue) return
      try { handlePayload(JSON.parse(event.newValue)) } catch {}
    }

    window.addEventListener('message', onMessage)
    window.addEventListener('storage', onStorage)
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = (event) => handlePayload(event.data)
    }

    pollTimer = window.setInterval(() => {
      if (settled) return
      try {
        const raw = window.localStorage.getItem(storageKey)
        if (raw) handlePayload(JSON.parse(raw))
      } catch {}
      if (popup && popup.closed) {
        fail(new Error('SSO window was closed before authorization completed.'))
      }
    }, 500)

    timeoutTimer = window.setTimeout(() => {
      fail(new Error('SSO authorization timed out.'))
    }, 5 * 60 * 1000)

    const starter = flow === 'login'
      ? ssoProvidersApi.getLoginUrl(providerId, callbackURL)
      : ssoProvidersApi.getLinkUrl(providerId, callbackURL)

    starter.then(({ url }) => {
      if (settled) return
      const navigation = navigateAuthorizationPopup(popup, url, {
        preserveOpener: true,
        allowHttp: true,
      })
      if (navigation.status === 'invalid') {
        fail(new Error('SSO provider returned an invalid authorization URL.'))
      } else if (navigation.status === 'blocked') {
        window.location.assign(navigation.url)
        settled = true
        cleanup()
        resolve(null)
      }
    }).catch((err) => {
      fail(err instanceof Error ? err : new Error('Failed to start SSO authorization.'))
    })
  })
}

export function publishSsoCompletion(result: SsoPopupResult) {
  const storageKey = `${STORAGE_PREFIX}${result.flowId}`
  try { window.opener?.postMessage({ type: 'lumiverse:sso-complete', payload: result }, window.location.origin) } catch {}
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage(result)
    channel.close()
  } catch {}
  try { window.localStorage.setItem(storageKey, JSON.stringify(result)) } catch {}
}
