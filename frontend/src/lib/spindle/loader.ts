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
          return registerTagInterceptor(extensionId, options, handler)
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
