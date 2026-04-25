import type { SpindleManifest, SpindleFrontendContext, SpindleFrontendModule, PermissionRequestOptions } from 'lumiverse-spindle-types'
import { createDOMHelper } from './dom-helper'
import { registerTagInterceptor, unregisterTagInterceptorsByExtension } from './message-interceptors'
import {
  createDrawerTabHandle,
  createFloatWidgetHandle,
  createDockPanelHandle,
  createAppMountHandle,
  createInputBarActionHandle,
  destroyAllPlacementsForExtension,
} from './placement-helper'
import { generateUUID } from '@/lib/uuid'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { useStore } from '@/store'

interface LoadedExtension {
  id: string
  identifier: string
  manifestSignature: string
  module: SpindleFrontendModule
  context: SpindleFrontendContext
  teardown?: () => void
  eventUnsubs: (() => void)[]
  backendHandlers: Set<(payload: unknown) => void>
  mountRoots: Element[]
  stopMountSync?: () => void
}

const loadedExtensions = new Map<string, LoadedExtension>()
const loadInFlight = new Map<string, Promise<void>>()
const loadGeneration = new Map<string, number>()

function getManifestSignature(manifest: SpindleManifest): string {
  return `${manifest.identifier}:${manifest.version}:${manifest.entry_frontend || 'dist/frontend.js'}`
}

async function doLoadFrontendExtension(
  extensionId: string,
  manifest: SpindleManifest
): Promise<void> {
  const generation = (loadGeneration.get(extensionId) || 0) + 1
  loadGeneration.set(extensionId, generation)

  const currentGeneration = () => loadGeneration.get(extensionId) === generation
  const manifestSignature = getManifestSignature(manifest)
  const existing = loadedExtensions.get(extensionId)

  if (existing?.manifestSignature === manifestSignature) {
    return
  }

  if (existing) {
    await unloadFrontendExtension(extensionId)
  }

  const bundleUrl = `/api/v1/spindle/${extensionId}/frontend`

  try {
    const response = await fetch(bundleUrl)
    if (!response.ok) return // No frontend bundle

    const code = await response.text()
    const blob = new Blob([code], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)

    const mod: SpindleFrontendModule = await import(/* @vite-ignore */ blobUrl)
    URL.revokeObjectURL(blobUrl)

    if (typeof mod.setup !== 'function') {
      console.warn(`[Spindle:${manifest.identifier}] Frontend module missing setup()`)
      return
    }

    const dom = createDOMHelper(extensionId)
    const eventUnsubs: (() => void)[] = []
    const backendHandlers = new Set<(payload: unknown) => void>()
    const mountRoots = new Map<string, Element>()

    // Cache granted permissions for synchronous permission checks in ui methods
    let cachedGrantedPermissions: string[] = []
    try {
      const permRes = await spindleApi.getPermissions(extensionId)
      cachedGrantedPermissions = permRes.granted
    } catch {
      // If we can't fetch permissions, default to empty (most restrictive)
    }
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

    const context: SpindleFrontendContext = {
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
      getActiveChat() {
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
      messages: {
        registerTagInterceptor(options, handler) {
          return registerTagInterceptor(extensionId, manifest.name || manifest.identifier || 'Extension', options, handler)
        },
      },
      manifest,
    }

    let teardownFn: void | (() => void)
    try {
      teardownFn = mod.setup(context)
    } catch (err) {
      dom.cleanup()
      cleanupMountInfra()
      throw err
    }

    if (!currentGeneration()) {
      try {
        if (typeof teardownFn === 'function') teardownFn()
        else mod.teardown?.()
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
      module: mod,
      context,
      teardown: typeof teardownFn === 'function' ? teardownFn : mod.teardown,
      eventUnsubs,
      backendHandlers,
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
  manifest: SpindleManifest
): Promise<void> {
  const pending = loadInFlight.get(extensionId)
  const next = (pending || Promise.resolve())
    .catch(() => {
      // continue queue even after previous failure
    })
    .then(() => doLoadFrontendExtension(extensionId, manifest))

  loadInFlight.set(extensionId, next)
  try {
    await next
  } finally {
    if (loadInFlight.get(extensionId) === next) {
      loadInFlight.delete(extensionId)
    }
  }
}

export async function unloadFrontendExtension(extensionId: string): Promise<void> {
  const loaded = loadedExtensions.get(extensionId)
  if (!loaded) return

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
  unregisterTagInterceptorsByExtension(extensionId)
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

export function getLoadedExtensions(): Map<string, LoadedExtension> {
  return loadedExtensions
}

export async function unloadAllFrontendExtensions(): Promise<void> {
  for (const [id] of loadedExtensions) {
    await unloadFrontendExtension(id)
  }
}
