import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { spindleApi } from '@/api/spindle'
import type { DesktopFloatingWidgetTarget } from '@/lib/desktop-floating-widget'
import {
  getLoadedExtensions,
  loadFrontendExtension,
  routeBackendMessage,
  routeFrontendProcessEvent,
  unloadFrontendExtension,
} from '@/lib/spindle/loader'
import { useStore } from '@/store'
import { EventType } from './events'
import { wsClient, WS_AUTH_ERROR, WS_CLOSE, WS_OPEN } from './client'
import { isTargetDesktopWidgetEvent } from './desktop-widget-event-isolation'

export type DesktopWidgetRuntimePhase =
  | 'authenticating'
  | 'connecting'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error'

type ExtensionEventPayload = {
  extensionId?: unknown
  operation?: unknown
}

type FrontendMessagePayload = {
  extensionId?: unknown
  data?: unknown
}

type FrontendProcessPayload = {
  extensionId?: unknown
  action?: unknown
  processId?: unknown
  kind?: unknown
  key?: unknown
  payload?: unknown
  metadata?: unknown
  reason?: unknown
  force?: unknown
}

function routeTargetProcessEvent(
  targetExtensionId: string,
  payload: FrontendProcessPayload,
): void {
  if (
    !isTargetDesktopWidgetEvent(targetExtensionId, payload)
    || typeof payload.action !== 'string'
    || typeof payload.processId !== 'string'
  ) return

  if (payload.action === 'spawn' && typeof payload.kind === 'string') {
    routeFrontendProcessEvent(targetExtensionId, {
      action: 'spawn',
      processId: payload.processId,
      kind: payload.kind,
      key: typeof payload.key === 'string' ? payload.key : undefined,
      payload: payload.payload,
      metadata: payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata as Record<string, unknown>
        : undefined,
    })
    return
  }

  if (payload.action === 'message') {
    routeFrontendProcessEvent(targetExtensionId, {
      action: 'message',
      processId: payload.processId,
      payload: payload.payload,
    })
    return
  }

  if (payload.action === 'stop') {
    routeFrontendProcessEvent(targetExtensionId, {
      action: 'stop',
      processId: payload.processId,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      ...(payload.force === true ? { force: true } : {}),
    })
  }
}

/**
 * A deliberately small WebSocket/runtime adapter for native widget windows.
 *
 * The application hook registers hundreds of unrelated handlers and hydrates
 * every enabled extension. A popup needs one authenticated session, the
 * target extension, and that extension's backend/process messages only.
 */
export function useDesktopWidgetRuntime(
  target: DesktopFloatingWidgetTarget | null,
): DesktopWidgetRuntimePhase {
  const [phase, setPhase] = useState<DesktopWidgetRuntimePhase>('authenticating')

  useEffect(() => {
    if (!target) {
      setPhase('unavailable')
      return
    }

    const nativeWindow = getCurrentWindow()
    const store = useStore
    let disposed = false
    let extensionRefreshTimer: number | undefined
    let hydrationQueue = Promise.resolve()

    const closeUnavailableWindow = async (): Promise<void> => {
      if (disposed) return
      setPhase('unavailable')
      await nativeWindow.close().catch(() => {})
    }

    const hydrateTarget = (force = false): Promise<void> => {
      hydrationQueue = hydrationQueue
        .catch(() => {})
        .then(async () => {
          if (disposed) return
          setPhase('loading')

          const { extensions, isPrivileged } = await spindleApi.list()
          if (disposed) return

          const extension = extensions.find((entry) => entry.id === target.extensionId)
          store.setState({
            // The child WebView is an isolated surface. Do not expose or
            // hydrate the rest of the user's extension catalog here.
            extensions: extension ? [extension] : [],
            spindlePrivileged: isPrivileged,
          })

          if (!extension?.enabled || !extension.has_frontend) {
            await unloadFrontendExtension(target.extensionId)
            await closeUnavailableWindow()
            return
          }

          const manifest = await spindleApi.getManifest(
            target.extensionId,
            force ? { force: true } : undefined,
          )
          if (disposed) return

          await loadFrontendExtension(target.extensionId, manifest, force, {
            desktopWidgetTarget: target,
          })
          if (disposed) return

          if (!getLoadedExtensions().has(target.extensionId)) {
            throw new Error(`Target extension frontend did not load: ${target.extensionId}`)
          }
          setPhase('ready')
        })
        .catch((error) => {
          if (disposed) return
          console.error('[desktop-widget] target runtime failed:', error)
          setPhase('error')
        })

      return hydrationQueue
    }

    const scheduleTargetRefresh = (force = false): void => {
      if (extensionRefreshTimer !== undefined) window.clearTimeout(extensionRefreshTimer)
      extensionRefreshTimer = window.setTimeout(() => {
        extensionRefreshTimer = undefined
        void hydrateTarget(force)
      }, 200)
    }

    const unsubs = [
      wsClient.on(WS_OPEN, () => {
        store.getState().setWsConnected(true)
        setPhase('connecting')
      }),
      wsClient.on(WS_CLOSE, () => {
        store.getState().setWsConnected(false)
        store.getState().setWsAuthSynced(false)
      }),
      wsClient.on(WS_AUTH_ERROR, () => {
        void closeUnavailableWindow()
      }),
      wsClient.on(EventType.CONNECTED, (payload: { role?: unknown }) => {
        // WebSocketClient emits a local CONNECTED on socket open. Only the
        // server acknowledgement includes a role and proves cookie auth.
        if (typeof payload?.role !== 'string' || payload.role.length === 0) return
        store.getState().reconcileRole(payload.role)
        store.getState().setWsAuthSynced(true)
        wsClient.forcePing()
        void hydrateTarget(false)
      }),
      wsClient.on(EventType.SETTINGS_UPDATED, () => {
        // Keep theme variables and extension core-setting watches current,
        // without installing the application's unrelated event handlers.
        void store.getState().loadSettings()
      }),
      wsClient.on(EventType.SPINDLE_FRONTEND_MSG, (payload: FrontendMessagePayload) => {
        if (!isTargetDesktopWidgetEvent(target.extensionId, payload)) return
        routeBackendMessage(target.extensionId, payload.data)
      }),
      wsClient.on(EventType.SPINDLE_FRONTEND_PROCESS, (payload: FrontendProcessPayload) => {
        routeTargetProcessEvent(target.extensionId, payload)
      }),
      wsClient.on(EventType.SPINDLE_EXTENSION_LOADED, (payload: ExtensionEventPayload) => {
        if (isTargetDesktopWidgetEvent(target.extensionId, payload)) scheduleTargetRefresh(false)
      }),
      wsClient.on(EventType.SPINDLE_EXTENSION_UNLOADED, (payload: ExtensionEventPayload) => {
        if (!isTargetDesktopWidgetEvent(target.extensionId, payload)) return
        setPhase('loading')
        void unloadFrontendExtension(target.extensionId)
        scheduleTargetRefresh(false)
      }),
      wsClient.on(EventType.SPINDLE_EXTENSION_STATUS, (payload: ExtensionEventPayload) => {
        if (!isTargetDesktopWidgetEvent(target.extensionId, payload)) return
        scheduleTargetRefresh(payload.operation === 'updated' || payload.operation === 'installed')
      }),
    ]

    void (async () => {
      await store.getState().checkSession()
      if (disposed) return
      if (!store.getState().isAuthenticated) {
        await closeUnavailableWindow()
        return
      }

      // Extensions may synchronously read audited core settings during setup.
      // Load them before allowing the authenticated socket acknowledgement to
      // hydrate the target frontend.
      await store.getState().loadSettings()
      if (disposed) return
      setPhase('connecting')
      wsClient.connect({ executionOwner: false })
    })().catch((error) => {
      if (disposed) return
      console.error('[desktop-widget] startup failed:', error)
      setPhase('error')
    })

    return () => {
      disposed = true
      if (extensionRefreshTimer !== undefined) window.clearTimeout(extensionRefreshTimer)
      for (const unsubscribe of unsubs) unsubscribe()
      store.getState().setWsConnected(false)
      store.getState().setWsAuthSynced(false)
      wsClient.disconnect()
      void unloadFrontendExtension(target.extensionId)
    }
  }, [target])

  return phase
}
