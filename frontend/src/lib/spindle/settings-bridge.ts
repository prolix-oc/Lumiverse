import type { CoreSettingKey } from './core-setting-keys'

const PRIVATE_SETTING_PREFIX = 'spindle:'
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/
const MODULE_PATTERN = /^[a-z][a-z0-9_]*$/
const PRIVATE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const MAX_SETTING_KEY_LENGTH = 200

/** Matches the normal settings-service serialized JSON limit. */
export const MAX_SETTING_VALUE_BYTES = 2 * 1024 * 1024

export interface SettingsPersistence {
  get(key: string): Promise<{ value: unknown } | undefined>
  set(key: string, value: unknown): Promise<unknown>
  remove(key: string): Promise<unknown>
}

export interface CoreSettingsReader {
  get(key: string): unknown
  subscribe(key: string, handler: (value: unknown) => void): () => void
  /** True once the host has merged the authoritative settings snapshot. */
  isReady?: () => boolean
}

export interface SettingsUpdatedEvent {
  readonly key?: string
  readonly value?: unknown
  readonly keys?: readonly string[]
  /** Internal marker used when the WS adapter also emits the browser event. */
  readonly source?: 'ws'
}

export interface SettingsBridgeOptions {
  readonly manifestIdentifier: string
  readonly coreSettingKeys: readonly CoreSettingKey[]
  readonly core: CoreSettingsReader
  readonly persistence: SettingsPersistence
  readonly hasPermission?: (permission: string) => boolean
  readonly onSettingsUpdated?: (
    handler: (event: SettingsUpdatedEvent) => void,
  ) => () => void
  readonly onTeardown?: (handler: () => void) => void
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export interface SpindleSettingsAPI {
  /** Read an extension-private value under the host-composed namespace. */
  get<T>(key: string): Promise<T | undefined>
  /** Persist an extension-private value under the host-composed namespace. */
  set<T>(key: string, value: T): Promise<void>
  /** Remove an extension-private value under the host-composed namespace. */
  remove(key: string): Promise<void>
  /** Watch an extension-private value and receive undefined after removal. */
  watch<T>(key: string, callback: (value: T | undefined) => void): () => void
  /** Audited host settings. There are intentionally no core write methods. */
  readonly core: {
    get<T>(key: string): T | undefined
    watch<T>(key: string, callback: (value: T) => void): () => void
    list(): Array<{ key: string; permission: string | null }>
    isReady(): boolean
  }
}

/** Host-owned extension of the published surface used during generation teardown. */
export interface SpindleSettingsBridge extends SpindleSettingsAPI {
  dispose(): void
}

type PrivateWatcher = (value: unknown) => void

function permissionError(permission: string): never {
  throw new Error(`PERMISSION_DENIED:${permission}`)
}

function ensureIdentifier(identifier: string): void {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`SETTING_IDENTIFIER_INVALID:${identifier}`)
  }
}

function ensurePrivatePath(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`SETTING_KEY_INVALID:${String(key)}`)
  }
  if (key.startsWith(PRIVATE_SETTING_PREFIX)) {
    throw new Error('SETTING_NAMESPACE_INVALID: caller-supplied namespace is not allowed')
  }
  const segments = key.split(':')
  if (segments.length !== 2 || segments.some((segment) => !PRIVATE_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`SETTING_KEY_INVALID:${key}`)
  }
  if (!MODULE_PATTERN.test(segments[0] ?? '')) {
    throw new Error(`SETTING_MODULE_INVALID:${segments[0] ?? ''}`)
  }
}

function composePrivateSettingKey(identifier: string, key: string): string {
  ensureIdentifier(identifier)
  ensurePrivatePath(key)
  const storageKey = `${PRIVATE_SETTING_PREFIX}${identifier}:${key}`
  if (storageKey.length > MAX_SETTING_KEY_LENGTH) {
    throw new Error(`SETTING_KEY_TOO_LONG:${MAX_SETTING_KEY_LENGTH}`)
  }
  return storageKey
}

export function validateSettingValue(value: unknown): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('SETTING_VALUE_NOT_SERIALIZABLE')
  }
  if (serialized === undefined) {
    throw new Error('SETTING_VALUE_NOT_SERIALIZABLE')
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SETTING_VALUE_BYTES) {
    throw new Error(`SETTING_VALUE_TOO_LARGE:${MAX_SETTING_VALUE_BYTES}`)
  }
}

function isSettingsUpdatedEvent(value: unknown): value is SettingsUpdatedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if ('key' in value && value.key !== undefined && typeof value.key !== 'string') return false
  if ('keys' in value && value.keys !== undefined) {
    if (!Array.isArray(value.keys) || !value.keys.every((key) => typeof key === 'string')) return false
  }
  return true
}

function settingEventDetail(event: Event): SettingsUpdatedEvent | undefined {
  if (!('detail' in event)) return undefined
  const detail = (event as CustomEvent<unknown>).detail
  return isSettingsUpdatedEvent(detail) ? detail : undefined
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && error.status === 404
}

/**
 * Creates the declared frontend settings surface. The caller supplies the
 * authenticated settings adapter and the core-store reader so this module
 * remains headless and unit-testable.
 */
export function createSettingsBridge(options: SettingsBridgeOptions): SpindleSettingsBridge {
  ensureIdentifier(options.manifestIdentifier)

  let traceSequence = 0
  const trace = (stage: string, data: Record<string, unknown>): void => {
    traceSequence += 1
    console.debug('[SettingsBridgeTrace]', {
      seq: traceSequence,
      at: new Date().toISOString(),
      extension: options.manifestIdentifier,
      stage,
      ...data,
    })
  }

  const coreSettings = new Map<string, CoreSettingKey>()
  for (const definition of options.coreSettingKeys) {
    if (coreSettings.has(definition.key)) {
      throw new Error(`CORE_SETTING_DUPLICATE:${definition.key}`)
    }
    coreSettings.set(definition.key, definition)
  }

  let disposed = false
  const privateWatchers = new Map<string, Set<PrivateWatcher>>()
  const coreSubscriptions = new Set<() => void>()

  const assertActive = () => {
    if (disposed) throw new Error('SETTINGS_BRIDGE_DISPOSED')
  }

  const notifyPrivate = (storageKey: string, value: unknown): void => {
    trace('private:notify', {
      storageKey,
      watcherCount: privateWatchers.get(storageKey)?.size ?? 0,
      hasValue: value !== undefined,
    })
    for (const watcher of privateWatchers.get(storageKey) ?? []) {
      try {
        watcher(value)
      } catch (error) {
        console.error('[Spindle] Settings watcher error:', error)
      }
    }
  }

  const refreshPrivate = async (storageKey: string): Promise<void> => {
    trace('private:refresh:start', { storageKey })
    try {
      const row = await options.persistence.get(storageKey)
      trace('private:refresh:result', { storageKey, found: row !== undefined })
      if (!disposed) notifyPrivate(storageKey, row?.value)
    } catch (error) {
      trace('private:refresh:failed', { storageKey })
      if (!disposed) {
        // A deleted row is represented as undefined. The watcher API has no
        // error channel, so a failed refresh must not create an unhandled
        // rejection in the extension bundle.
        notifyPrivate(storageKey, undefined)
      }
    }
  }

  const refreshMatchingPrivateWatchers = (event: SettingsUpdatedEvent): void => {
    const changedKeys = event.key ? [event.key] : event.keys ?? []
    trace('serverUpdate', {
      changedKeys,
      source: event.source ?? 'host',
      watchedKeys: [...privateWatchers.keys()],
    })
    for (const storageKey of privateWatchers.keys()) {
      if (event.key === storageKey && Object.prototype.hasOwnProperty.call(event, 'value')) {
        notifyPrivate(storageKey, event.value)
      } else if (changedKeys.length === 0 || changedKeys.includes(storageKey)) {
        void refreshPrivate(storageKey)
      }
    }
  }

  const onWindowSettingChanged = (event: Event): void => {
    const detail = settingEventDetail(event)
    if (!detail || detail.source === 'ws') return
    refreshMatchingPrivateWatchers(detail)
  }

  const browserWindow = options.window ?? (typeof window === 'undefined' ? undefined : window)
  browserWindow?.addEventListener('lumiverse:setting-changed', onWindowSettingChanged)
  const unsubscribeSettingsUpdated = options.onSettingsUpdated?.(refreshMatchingPrivateWatchers)

  const resolveCore = (key: string): CoreSettingKey => {
    assertActive()
    const definition = coreSettings.get(key)
    if (!definition) throw new Error(`CORE_SETTING_UNKNOWN:${key}`)
    if (definition.permission && !options.hasPermission?.(definition.permission)) {
      permissionError(definition.permission)
    }
    return definition
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    browserWindow?.removeEventListener('lumiverse:setting-changed', onWindowSettingChanged)
    unsubscribeSettingsUpdated?.()
    for (const unsubscribe of coreSubscriptions) {
      try { unsubscribe() } catch { /* no-op */ }
    }
    coreSubscriptions.clear()
    privateWatchers.clear()
  }

  options.onTeardown?.(dispose)

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const storageKey = composePrivateSettingKey(options.manifestIdentifier, key)
      assertActive()
      trace('private:get:start', { key, storageKey })
      try {
        const row = await options.persistence.get(storageKey)
        assertActive()
        trace('private:get:result', { key, storageKey, found: row !== undefined })
        return row?.value as T | undefined
      } catch (error) {
        if (isNotFound(error)) {
          assertActive()
          trace('private:get:result', { key, storageKey, found: false })
          return undefined
        }
        throw error
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      const storageKey = composePrivateSettingKey(options.manifestIdentifier, key)
      validateSettingValue(value)
      assertActive()
      trace('private:set:start', { key, storageKey })
      await options.persistence.set(storageKey, value)
      assertActive()
      trace('private:set:committed', { key, storageKey })
      notifyPrivate(storageKey, value)
    },
    async remove(key: string): Promise<void> {
      const storageKey = composePrivateSettingKey(options.manifestIdentifier, key)
      assertActive()
      try {
        await options.persistence.remove(storageKey)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      assertActive()
      notifyPrivate(storageKey, undefined)
    },
    watch<T>(key: string, callback: (value: T | undefined) => void): () => void {
      const storageKey = composePrivateSettingKey(options.manifestIdentifier, key)
      assertActive()
      let watchers = privateWatchers.get(storageKey)
      if (!watchers) {
        watchers = new Set<PrivateWatcher>()
        privateWatchers.set(storageKey, watchers)
      }
      const watcher: PrivateWatcher = (value) => callback(value as T | undefined)
      watchers.add(watcher)
      trace('private:watch:subscribed', { key, storageKey, watcherCount: watchers.size })

      let active = true
      return () => {
        if (!active) return
        active = false
        watchers?.delete(watcher)
        trace('private:watch:unsubscribed', { key, storageKey, watcherCount: watchers?.size ?? 0 })
        if (watchers?.size === 0) privateWatchers.delete(storageKey)
      }
    },
    core: {
      get<T>(key: string): T | undefined {
        resolveCore(key)
        const value = options.core.get(key) as T | undefined
        trace('core:get', { key, found: value !== undefined })
        return value
      },
      watch<T>(key: string, callback: (value: T) => void): () => void {
        resolveCore(key)
        const unsubscribe = options.core.subscribe(key, (value) => {
          trace('core:watch:event', { key, hasValue: value !== undefined })
          try { callback(value as T) } catch (error) { console.error('[Spindle] Core settings watcher error:', error) }
        })
        coreSubscriptions.add(unsubscribe)
        trace('core:watch:subscribed', { key })
        let active = true
        return () => {
          if (!active) return
          active = false
          coreSubscriptions.delete(unsubscribe)
          trace('core:watch:unsubscribed', { key })
          unsubscribe()
        }
      },
      list(): Array<{ key: string; permission: string | null }> {
        assertActive()
        return options.coreSettingKeys.map(({ key, permission }) => ({ key, permission }))
      },
      isReady(): boolean {
        return options.core.isReady?.() ?? true
      },
    },
    dispose,
  }
}
