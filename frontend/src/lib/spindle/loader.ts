import type { SpindleManifest, SpindleFrontendContext, PermissionRequestOptions } from 'lumiverse-spindle-types'
import { createDOMHelper } from './dom-helper'
import { registerTagInterceptor, unregisterTagInterceptorsByExtension } from './message-interceptors'
import { removeMessageWidgetsByExtension, upsertMessageWidget, removeMessageWidget } from './message-widgets'
import {
  createDrawerTabHandle,
  createFloatWidgetHandle,
  createDockPanelHandle,
  createAppMountHandle,
  createInputBarActionHandle,
  destroyAllPlacementsForExtension,
} from './placement-helper'
import { generateUUID } from '@/lib/uuid'
import { installSpindleNavigationGuards } from './navigation-guards'
import { SandboxedFrontendRuntime } from './sandboxed-frontend-runtime'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { charactersApi } from '@/api/characters'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'

interface LoadedExtension {
  id: string
  identifier: string
  manifestSignature: string
  context: SpindleFrontendContext
  runtime: SandboxedFrontendRuntime
  teardown?: () => void
  eventUnsubs: (() => void)[]
  backendHandlers: Set<(payload: unknown) => void>
  processHandlers: Map<string, FrontendProcessHandler>
  activeProcesses: Map<string, ActiveFrontendProcess>
  mountRoots: Element[]
  stopMountSync?: () => void
}

type FrontendProcessHandler = (
  process: FrontendProcessContextLocal,
) => void | (() => void) | Promise<void | (() => void)>

interface FrontendProcessContextLocal {
  processId: string
  kind: string
  key?: string
  payload: unknown
  metadata?: Record<string, unknown>
  ready(): void
  heartbeat(): void
  send(payload: unknown): void
  onMessage(handler: (payload: unknown) => void): () => void
  complete(result?: unknown): void
  fail(error: string): void
  onStop(handler: (detail: { reason?: string }) => void): () => void
}

interface ActiveFrontendProcess {
  processId: string
  kind: string
  key?: string
  payload: unknown
  metadata?: Record<string, unknown>
  readySent: boolean
  terminal: boolean
  cleanup?: () => void | Promise<void>
  messageHandlers: Set<(payload: unknown) => void>
  stopHandlers: Set<(detail: { reason?: string }) => void>
}

type FrontendRuntimeContext = SpindleFrontendContext & {
  processes: {
    register(kind: string, handler: FrontendProcessHandler): () => void
  }
  messages: SpindleFrontendContext['messages'] & {
    renderWidget(
      options: { messageId: string; widgetId: string; html: string; minHeight?: number; maxHeight?: number },
      handler?: (payload: unknown) => void,
    ): () => void
    removeWidget(messageId: string, widgetId: string): void
  }
  characters: {
    get(characterId: string): Promise<unknown>
  }
  chats: {
    updateMessage(chatId: string, messageId: string, input: { content?: string }): Promise<unknown>
  }
}

type FrontendProcessWirePayload =
  | {
      action: 'spawn'
      processId: string
      kind: string
      key?: string
      payload?: unknown
      metadata?: Record<string, unknown>
    }
  | {
      action: 'message'
      processId: string
      payload: unknown
    }
  | {
      action: 'stop'
      processId: string
      reason?: string
    }

const loadedExtensions = new Map<string, LoadedExtension>()
const loadInFlight = new Map<string, { promise: Promise<void>; force: boolean; manifestSignature: string }>()
const loadGeneration = new Map<string, number>()
const recentForceLoads = new Map<string, { manifestSignature: string; completedAt: number }>()
const FORCE_LOAD_DEDUPE_MS = 2000

function getManifestSignature(manifest: SpindleManifest): string {
  return `${manifest.identifier}:${manifest.version}:${manifest.entry_frontend || 'dist/frontend.js'}`
}

async function doLoadFrontendExtension(
  extensionId: string,
  manifest: SpindleManifest,
  force = false
): Promise<void> {
  const generation = (loadGeneration.get(extensionId) || 0) + 1
  loadGeneration.set(extensionId, generation)

  const currentGeneration = () => loadGeneration.get(extensionId) === generation
  const manifestSignature = getManifestSignature(manifest)
  const existing = loadedExtensions.get(extensionId)

  if (!force && existing?.manifestSignature === manifestSignature) {
    return
  }

  if (existing) {
    await unloadFrontendExtension(extensionId)
  }

  const bundleUrl = `/api/v1/spindle/${extensionId}/frontend`

  try {
    const responsePromise = fetch(bundleUrl)
    const permissionsPromise = spindleApi.getPermissions(extensionId)
      .then((permRes) => permRes.granted)
      .catch(() => [] as string[])
    installSpindleNavigationGuards()

    const response = await responsePromise
    if (!response.ok) return // No frontend bundle

    const frontendCode = await response.text()

    // SECURITY: frontend extension modules execute in an opaque-origin sandbox
    // iframe, not in the Lumiverse document. Host capabilities are exposed only
    // through the RPC bridge below; extension-owned visible UI is rendered into
    // host-created nested sandbox frames.

    const dom = createDOMHelper(extensionId)
    const eventUnsubs: (() => void)[] = []
    const backendHandlers = new Set<(payload: unknown) => void>()
    const processHandlers = new Map<string, FrontendProcessHandler>()
    const activeProcesses = new Map<string, ActiveFrontendProcess>()
    const mountRoots = new Map<string, Element>()

    // Cache granted permissions for synchronous permission checks in ui methods
    let cachedGrantedPermissions: string[] = await permissionsPromise
    const mountedPoints = new Set<string>()
    let openModalCount = 0

    const attachMountRoots = () => {
      for (const [point, root] of mountRoots) {
        const selector = `[data-spindle-mount="${point}"]`
        const target = document.querySelector(selector)
        if (!target) continue
        if (root.parentElement !== target) {
          target.appendChild(root)
        }
      }
    }

    const mountObserver = new MutationObserver(() => {
      attachMountRoots()
    })
    mountObserver.observe(document.body, { childList: true, subtree: true })

    const cleanupMountInfra = () => {
      mountObserver.disconnect()
      for (const node of mountRoots.values()) {
        try {
          node.remove()
        } catch {
          // no-op
        }
      }
      mountRoots.clear()
      mountedPoints.clear()
    }
    const context: FrontendRuntimeContext = {
      dom,
      events: {
        on(event: string, handler: (payload: unknown) => void): () => void {
          const unsub = wsClient.on(event, handler)
          eventUnsubs.push(unsub)
          return () => {
            unsub()
            const idx = eventUnsubs.indexOf(unsub)
            if (idx !== -1) eventUnsubs.splice(idx, 1)
          }
        },
        emit(event: string, payload: unknown): void {
          // Frontend-only events — extensions can use this for inter-extension communication
          window.dispatchEvent(
            new CustomEvent(`spindle:${event}`, { detail: payload })
          )
        },
      },
      ui: {
        mount(point) {
          let root = mountRoots.get(point)
          if (!root) {
            root = document.createElement('div')
            root.setAttribute('data-spindle-extension-root', extensionId)
            root.setAttribute('data-spindle-mount-point', point)
            mountRoots.set(point, root)
          }
          if (!mountedPoints.has(point)) {
            root.replaceChildren()
            mountedPoints.add(point)
          }
          attachMountRoots()
          return root
        },
        registerDrawerTab(options) {
          return createDrawerTabHandle(extensionId, options)
        },
        createFloatWidget(options) {
          const granted = cachedGrantedPermissions
          if (!granted.includes('ui_panels')) {
            throw new Error('PERMISSION_DENIED:ui_panels — createFloatWidget requires the ui_panels permission')
          }
          return createFloatWidgetHandle(extensionId, options)
        },
        requestDockPanel(options) {
          const granted = cachedGrantedPermissions
          if (!granted.includes('ui_panels')) {
            throw new Error('PERMISSION_DENIED:ui_panels — requestDockPanel requires the ui_panels permission')
          }
          return createDockPanelHandle(extensionId, options)
        },
        mountApp(options) {
          const granted = cachedGrantedPermissions
          if (!granted.includes('app_manipulation')) {
            throw new Error('PERMISSION_DENIED:app_manipulation — mountApp requires the app_manipulation permission')
          }
          return createAppMountHandle(extensionId, options)
        },
        registerInputBarAction(options) {
          return createInputBarActionHandle(extensionId, manifest.name, options)
        },
        showContextMenu(options: {
          position: { x: number; y: number }
          items: Array<{
            key: string
            label: string
            disabled?: boolean
            danger?: boolean
            active?: boolean
            type?: 'item' | 'divider'
          }>
        }): Promise<{ selectedKey: string | null }> {
          const requestId = generateUUID()

          return new Promise<{ selectedKey: string | null }>((resolve) => {
            const handler = ((e: CustomEvent) => {
              if (e.detail.requestId !== requestId) return
              window.removeEventListener('spindle:context-menu-resolved', handler)
              resolve({ selectedKey: e.detail.selectedKey })
            }) as EventListener

            window.addEventListener('spindle:context-menu-resolved', handler)

            useStore.getState().openContextMenu({
              requestId,
              extensionId,
              position: options.position,
              items: options.items,
            })
          })
        },
        showModal(options) {
          if (openModalCount >= 2) throw new Error('Maximum of 2 stacked modals per extension')
          openModalCount++

          const modalId = generateUUID()
          const root = document.createElement('div')
          root.setAttribute('data-spindle-modal', modalId)
          const dismissHandlers = new Set<() => void>()
          let dismissed = false

          // Create host elements
          const backdrop = document.createElement('div')
          Object.assign(backdrop.style, {
            position: 'fixed', inset: '0', zIndex: '10003',
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          })

          const container = document.createElement('div')
          const w = Math.min(options?.width || 420, window.innerWidth - 40)
          const mh = Math.min(options?.maxHeight || 520, window.innerHeight - 40)
          Object.assign(container.style, {
            width: `${w}px`, maxHeight: `${mh}px`,
            background: 'var(--lumiverse-bg)', borderRadius: '12px',
            border: '1px solid var(--lumiverse-border)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          })

          const header = document.createElement('div')
          Object.assign(header.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: '1px solid var(--lumiverse-border)',
          })
          const titleEl = document.createElement('h3')
          Object.assign(titleEl.style, { margin: '0', fontSize: 'calc(15px * var(--lumiverse-font-scale, 1))', fontWeight: '600', color: 'var(--lumiverse-text)' })
          titleEl.textContent = options?.title || ''
          header.appendChild(titleEl)

          if (!options?.persistent) {
            const closeBtn = document.createElement('button')
            Object.assign(closeBtn.style, {
              background: 'none', border: 'none', color: 'var(--lumiverse-text-dim)',
              cursor: 'pointer', padding: '4px', borderRadius: '4px', lineHeight: '0',
            })
            closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
            closeBtn.onclick = () => handle.dismiss()
            header.appendChild(closeBtn)
          }

          const body = document.createElement('div')
          Object.assign(body.style, { padding: '16px', overflowY: 'auto', flex: '1' })
          body.appendChild(root)

          container.appendChild(header)
          container.appendChild(body)
          backdrop.appendChild(container)

          if (!options?.persistent) {
            backdrop.addEventListener('click', (e) => {
              if (e.target === backdrop) handle.dismiss()
            })
          }

          document.body.appendChild(backdrop)

          const handle = {
            root,
            modalId,
            dismiss() {
              if (dismissed) return
              dismissed = true
              openModalCount--
              backdrop.remove()
              for (const h of dismissHandlers) { try { h() } catch {} }
              dismissHandlers.clear()
            },
            setTitle(title: string) {
              titleEl.textContent = title
            },
            onDismiss(handler: () => void) {
              dismissHandlers.add(handler)
              return () => { dismissHandlers.delete(handler) }
            },
          }

          return handle
        },
        async showConfirm(options) {
          if (openModalCount >= 2) throw new Error('Maximum of 2 stacked modals per extension')
          openModalCount++

          const requestId = generateUUID()

          return new Promise<{ confirmed: boolean }>((resolve) => {
            const handler = ((e: CustomEvent) => {
              if (e.detail?.requestId !== requestId) return
              window.removeEventListener('spindle:confirm-resolved', handler)
              openModalCount--
              resolve({ confirmed: !!e.detail.confirmed })
            }) as EventListener

            window.addEventListener('spindle:confirm-resolved', handler)

            useStore.getState().openSpindleConfirm({
              requestId,
              extensionId,
              extensionName: manifest.name,
              title: options.title,
              message: options.message,
              variant: options.variant || 'info',
              confirmLabel: options.confirmLabel || 'Confirm',
              cancelLabel: options.cancelLabel || 'Cancel',
            })
          })
        },
      },
      uploads: {
        async pickFile(options) {
          const input = document.createElement('input')
          input.type = 'file'
          input.style.display = 'none'
          input.multiple = !!options?.multiple
          if (options?.accept?.length) {
            input.accept = options.accept.join(',')
          }

          document.body.appendChild(input)

          const selected = await new Promise<File[]>((resolve) => {
            input.addEventListener(
              'change',
              () => {
                resolve(Array.from(input.files || []))
              },
              { once: true }
            )
            input.click()
          })

          input.remove()

          if (options?.maxSizeBytes !== undefined) {
            const tooLarge = selected.find((file) => file.size > options.maxSizeBytes!)
            if (tooLarge) {
              throw new Error(`File exceeds maxSizeBytes: ${tooLarge.name}`)
            }
          }

          return Promise.all(
            selected.map(async (file) => ({
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              bytes: new Uint8Array(await file.arrayBuffer()),
            }))
          )
        },
      },
      permissions: {
        async getGranted() {
          const res = await spindleApi.getPermissions(extensionId)
          return res.granted
        },
        async request(permissions: string[], options?: PermissionRequestOptions) {
          // Filter out already-granted permissions — no modal needed if everything is granted
          const needed = permissions.filter((p) => !cachedGrantedPermissions.includes(p))
          if (needed.length === 0) return cachedGrantedPermissions

          const requestId = generateUUID()

          return new Promise<string[]>((resolve, reject) => {
            const handler = ((e: CustomEvent) => {
              if (e.detail.requestId !== requestId) return
              window.removeEventListener('spindle:permission-resolved', handler)
              if (e.detail.approved) {
                cachedGrantedPermissions = e.detail.granted
                resolve(e.detail.granted)
              } else {
                reject(new Error('Permission request denied by user'))
              }
            }) as EventListener

            window.addEventListener('spindle:permission-resolved', handler)

            useStore.getState().showPermissionRequest({
              id: requestId,
              extensionId,
              extensionName: manifest.name,
              permissions: needed,
              reason: options?.reason,
            })
          })
        },
      },
      async getActiveChat() {
        const state = useStore.getState()
        return {
          chatId: state.activeChatId ?? null,
          characterId: state.activeCharacterId ?? null,
        }
      },
      sendToBackend(payload: unknown): void {
        // Send via WebSocket to the backend worker
        wsClient.send({
          type: 'SPINDLE_BACKEND_MSG',
          extensionId,
          payload,
        })
      },
      onBackendMessage(handler: (payload: unknown) => void): () => void {
        backendHandlers.add(handler)
        return () => {
          backendHandlers.delete(handler)
        }
      },
      processes: {
        register(kind: string, handler: FrontendProcessHandler): () => void {
          const normalized = kind.trim()
          if (!normalized) {
            throw new Error('process kind is required')
          }
          processHandlers.set(normalized, handler)
          return () => {
            if (processHandlers.get(normalized) === handler) {
              processHandlers.delete(normalized)
            }
          }
        },
      },
      messages: {
        registerTagInterceptor(options, handler) {
          return registerTagInterceptor(extensionId, manifest.name || manifest.identifier || 'Extension', options, handler)
        },
        renderWidget(options: {
          messageId: string
          widgetId: string
          html: string
          minHeight?: number
          maxHeight?: number
        }, handler?: (payload: unknown) => void) {
          upsertMessageWidget(extensionId, options, handler)
          return () => removeMessageWidget(extensionId, options.messageId, options.widgetId)
        },
        removeWidget(messageId: string, widgetId: string) {
          removeMessageWidget(extensionId, messageId, widgetId)
        },
      },
      characters: {
        get(characterId: string) {
          return charactersApi.get(characterId)
        },
      },
      chats: {
        async updateMessage(chatId: string, messageId: string, input: { content?: string }) {
          const updated = await messagesApi.update(chatId, messageId, input)
          useStore.getState().updateMessage(updated.id, updated)
          return updated
        },
      },
      manifest,
    }

    const runtime = new SandboxedFrontendRuntime(extensionId, manifest, frontendCode, context)
    try {
      await runtime.start()
    } catch (err) {
      runtime.destroy()
      dom.cleanup()
      cleanupMountInfra()
      throw err
    }

    if (!currentGeneration()) {
      try {
        runtime.destroy()
      } catch {
        // no-op
      }
      dom.cleanup()
      cleanupMountInfra()
      return
    }

    loadedExtensions.set(extensionId, {
      id: extensionId,
      identifier: manifest.identifier,
      manifestSignature,
      context,
      runtime,
      teardown: () => runtime.destroy(),
      eventUnsubs,
      backendHandlers,
      processHandlers,
      activeProcesses,
      mountRoots: Array.from(mountRoots.values()),
      stopMountSync: cleanupMountInfra,
    })

    console.log(`[Spindle] Loaded frontend: ${manifest.identifier}`)
  } catch (err) {
    console.error(`[Spindle] Failed to load frontend for ${manifest.identifier}:`, err)
  }
}

export async function loadFrontendExtension(
  extensionId: string,
  manifest: SpindleManifest,
  force = false
): Promise<void> {
  const manifestSignature = getManifestSignature(manifest)
  const pending = loadInFlight.get(extensionId)

  if (force) {
    const recent = recentForceLoads.get(extensionId)
    if (recent?.manifestSignature === manifestSignature && Date.now() - recent.completedAt < FORCE_LOAD_DEDUPE_MS) {
      return
    }
  }

  if (pending && (!force || (pending.force && pending.manifestSignature === manifestSignature))) {
    await pending.promise
    return
  }

  const next = (pending?.promise || Promise.resolve())
    .catch(() => {
      // continue queue even after previous failure
    })
    .then(() => doLoadFrontendExtension(extensionId, manifest, force))

  loadInFlight.set(extensionId, { promise: next, force, manifestSignature })
  try {
    await next
    if (force) {
      recentForceLoads.set(extensionId, { manifestSignature, completedAt: Date.now() })
    }
  } finally {
    if (loadInFlight.get(extensionId)?.promise === next) {
      loadInFlight.delete(extensionId)
    }
  }
}

export async function unloadFrontendExtension(extensionId: string): Promise<void> {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) return

  for (const process of Array.from(loaded.activeProcesses.values())) {
    try {
      loaded.activeProcesses.delete(process.processId)
      process.terminal = true
      void process.cleanup?.()
      process.messageHandlers.clear()
      process.stopHandlers.clear()
      wsClient.send({
        type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
        extensionId,
        processId: process.processId,
        event: 'frontend_unloaded',
      })
    } catch {
      // no-op
    }
  }

  try {
    loaded.teardown?.()
  } catch (err) {
    console.error(`[Spindle] Teardown error for ${loaded.identifier}:`, err)
  }

  // Clean up DOM
  loaded.context.dom.cleanup()
  loaded.stopMountSync?.()
  for (const node of loaded.mountRoots) {
    try {
      node.remove()
    } catch {
      // no-op
    }
  }

  // Clean up event subscriptions
  for (const unsub of loaded.eventUnsubs) {
    unsub()
  }

  loaded.backendHandlers.clear()
  loaded.processHandlers.clear()
  unregisterTagInterceptorsByExtension(extensionId)
  removeMessageWidgetsByExtension(extensionId)
  destroyAllPlacementsForExtension(extensionId)
  loadedExtensions.delete(extensionId)

  console.log(`[Spindle] Unloaded frontend: ${loaded.identifier}`)
}

export function routeBackendMessage(extensionId: string, payload: unknown): void {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) return

  for (const handler of loaded.backendHandlers) {
    try {
      handler(payload)
    } catch (err) {
      console.error(`[Spindle] Backend message handler error for ${loaded.identifier}:`, err)
    }
  }
}

export function routeFrontendProcessEvent(extensionId: string, payload: FrontendProcessWirePayload): void {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) return

  if (payload.action === 'spawn') {
    void (async () => {
      const handler = loaded.processHandlers.get(payload.kind)
      if (!handler) {
        wsClient.send({
          type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
          extensionId,
          processId: payload.processId,
          event: 'fail',
          error: `No frontend process handler registered for kind \"${payload.kind}\"`,
        })
        return
      }

      const process: ActiveFrontendProcess = {
        processId: payload.processId,
        kind: payload.kind,
        key: payload.key,
        payload: payload.payload,
        metadata: payload.metadata,
        readySent: false,
        terminal: false,
        messageHandlers: new Set(),
        stopHandlers: new Set(),
      }
      loaded.activeProcesses.set(payload.processId, process)

      const ctx: FrontendProcessContextLocal = {
        processId: payload.processId,
        kind: payload.kind,
        ...(payload.key ? { key: payload.key } : {}),
        payload: payload.payload,
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
        ready() {
          if (process.terminal || process.readySent) return
          process.readySent = true
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'ready',
          })
        },
        heartbeat() {
          if (process.terminal) return
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'heartbeat',
          })
        },
        send(messagePayload: unknown) {
          if (process.terminal) return
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_MSG',
            extensionId,
            processId: payload.processId,
            payload: messagePayload,
          })
        },
        onMessage(handler) {
          process.messageHandlers.add(handler)
          return () => {
            process.messageHandlers.delete(handler)
          }
        },
        complete(_result?: unknown) {
          if (process.terminal) return
          process.terminal = true
          loaded.activeProcesses.delete(process.processId)
          try { void process.cleanup?.() } catch {}
          process.messageHandlers.clear()
          process.stopHandlers.clear()
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'complete',
          })
        },
        fail(error: string) {
          if (process.terminal) return
          process.terminal = true
          loaded.activeProcesses.delete(process.processId)
          try { void process.cleanup?.() } catch {}
          process.messageHandlers.clear()
          process.stopHandlers.clear()
          wsClient.send({
            type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
            extensionId,
            processId: payload.processId,
            event: 'fail',
            error,
          })
        },
        onStop(handler) {
          process.stopHandlers.add(handler)
          return () => {
            process.stopHandlers.delete(handler)
          }
        },
      }

      try {
        const cleanup = await handler(ctx)
        if (typeof cleanup === 'function') {
          process.cleanup = cleanup
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.fail(message)
      }
    })()
    return
  }

  const process = loaded.activeProcesses.get(payload.processId)
  if (!process) return

  if (payload.action === 'message') {
    for (const handler of process.messageHandlers) {
      try {
        handler(payload.payload)
      } catch (err) {
        console.error(`[Spindle] Frontend process message handler error for ${loaded.identifier}:`, err)
      }
    }
    return
  }

  if (payload.action === 'stop') {
    if (process.stopHandlers.size === 0) {
      process.terminal = true
      loaded.activeProcesses.delete(process.processId)
      try { void process.cleanup?.() } catch {}
      process.messageHandlers.clear()
      process.stopHandlers.clear()
      wsClient.send({
        type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
        extensionId,
        processId: payload.processId,
        event: 'complete',
      })
      return
    }

    for (const handler of process.stopHandlers) {
      try {
        handler({ reason: payload.reason })
      } catch (err) {
        console.error(`[Spindle] Frontend process stop handler error for ${loaded.identifier}:`, err)
      }
    }
  }
}

export function getLoadedExtensions(): Map<string, LoadedExtension> {
  return loadedExtensions
}

export async function unloadAllFrontendExtensions(): Promise<void> {
  for (const [id] of loadedExtensions) {
    await unloadFrontendExtension(id)
  }
}
