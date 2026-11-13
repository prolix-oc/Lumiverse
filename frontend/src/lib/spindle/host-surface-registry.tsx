import type { ReactElement } from 'react'

import { frontendAuthorityRow } from './frontend-authority-map'

/**
 * Generation-scoped registry primitive used by host-surface joins.
 *
 * It deliberately stores plain snapshots rather than React elements.  React
 * host-surface mounting is a separate hook; this registry only provides the
 * ownership, subscription, and teardown mechanics needed by H4 catalogs.
 */

export interface HostSurfaceRegistryEntry<T> {
  readonly id: string
  readonly generation: number
  readonly value: T
}
export interface HostSurfaceRegistryOptions {
  readonly maxEntries?: number
  readonly onTeardown?: (handler: () => void) => () => void
}

export class HostSurfaceRegistry<T> {
  private readonly entries = new Map<string, HostSurfaceRegistryEntry<T>>()
  private readonly subscribers = new Set<(entries: readonly HostSurfaceRegistryEntry<T>[]) => void>()
  private readonly maxEntries: number
  private disposed = false
  private teardownUnsubscribe: (() => void) | undefined

  constructor(options: HostSurfaceRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 128
    if (options.onTeardown) {
      this.teardownUnsubscribe = options.onTeardown(() => this.dispose())
    }
  }

  register(id: string, value: T, generation: number): () => void {
    this.assertUsable()
    if (!id || id.length > 128) throw new Error('HOST_SURFACE_INVALID_ID')
    if (this.entries.has(id)) throw new Error(`HOST_SURFACE_DUPLICATE:${id}`)
    if (this.entries.size >= this.maxEntries) throw new Error(`HOST_SURFACE_LIMIT:${this.maxEntries}`)

    const entry: HostSurfaceRegistryEntry<T> = Object.freeze({ id, generation, value })
    this.entries.set(id, entry)
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
        this.notify()
      }
    }
  }

  list(): readonly HostSurfaceRegistryEntry<T>[] {
    this.assertUsable()
    return Object.freeze([...this.entries.values()])
  }

  subscribe(handler: (entries: readonly HostSurfaceRegistryEntry<T>[]) => void): () => void {
    this.assertUsable()
    this.subscribers.add(handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.subscribers.delete(handler)
    }
  }

  clearGeneration(generation: number): void {
    this.assertUsable()
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.generation !== generation) continue
      this.entries.delete(id)
      changed = true
    }
    if (changed) this.notify()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.subscribers.clear()
    this.teardownUnsubscribe?.()
    this.teardownUnsubscribe = undefined
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: host surface registry is disposed')
  }

  private notify(): void {
    const snapshot = Object.freeze([...this.entries.values()])
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(snapshot) } catch { /* observer isolation */ }
    }
  }
}

// ---------------------------------------------------------------------------
// H7 static host-surface registry
// ---------------------------------------------------------------------------

export type HostSurfaceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HostSurfaceJsonValue[]
  | { readonly [key: string]: HostSurfaceJsonValue }

export type HostSurfaceProps = Record<string, HostSurfaceJsonValue>

// Published spindle declarations intentionally accept arbitrary event payloads.
// Keep the registry boundary equally broad; renderers may still validate JSON.
export type HostSurfaceEventHandler = (payload: unknown) => void
export type HostSurfaceUnsubscribe = () => void

export interface SpindleHostSurfaceHandle {
  update(props: HostSurfaceProps): void
  destroy(): void
  /** Accept both legacy JSON-only and newer unknown-payload declarations. */
  on(event: string, handler: HostSurfaceEventHandler | ((payload: HostSurfaceJsonValue) => void)): HostSurfaceUnsubscribe
}

export interface SpindleHostSurfaceInfo {
  readonly id: string
  readonly permission: string | null
  readonly propsSchema: string
}

export interface HostSurfaceRenderContext {
  readonly extensionId: string
  emit(event: string, payload: HostSurfaceJsonValue): void
}

export type HostSurfaceRenderer = (
  props: Record<string, unknown>,
  context: HostSurfaceRenderContext,
) => ReactElement

type PropSpec =
  | { readonly kind: 'string'; readonly required?: boolean; readonly max?: number; readonly pattern?: RegExp; readonly enum?: readonly string[] }
  | { readonly kind: 'number'; readonly required?: boolean; readonly min?: number; readonly max?: number; readonly int?: boolean }
  | { readonly kind: 'boolean'; readonly required?: boolean }
  | { readonly kind: 'string[]'; readonly required?: boolean; readonly maxItems?: number; readonly maxLength?: number }
  | { readonly kind: 'object'; readonly required?: boolean }
  | { readonly kind: 'object[]'; readonly required?: boolean; readonly maxItems?: number }

type HostSurfaceRow = {
  readonly id: string
  readonly schema: Readonly<Record<string, PropSpec>>
  readonly propsSchema: string
  readonly validate?: (props: HostSurfaceProps) => void
}

const MAX_STRING_LENGTH = 4096
const MAX_DEPTH = 8
const MAX_ARRAY_LENGTH = 256
const MAX_OBJECT_KEYS = 64
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const PRODUCTIVITY_SURFACE_SCHEMA: Readonly<Record<string, PropSpec>> = {
  contractVersion: { kind: 'number', required: true, min: 1, max: 1, int: true },
  ownerToken: { kind: 'string', required: true, max: 128, pattern: OWNER_TOKEN_PATTERN },
  generation: { kind: 'number', required: true, min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
  capabilities: { kind: 'string[]', required: true, maxItems: 32, maxLength: 64 },
  state: { kind: 'object' },
}

const PRODUCTIVITY_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'productivity.settings.workspace': [],
  'quick_toolbar.workspace': [],
  'connections_picker.launcher': ['open'],
  'connections_picker.panel': ['close'],
  'activated_lore.indicator': ['open'],
  'activated_lore.panel': ['close'],
  'portrait_dock.workspace': [],
  'lorebook.half.action': ['open'],
  'lorebook.half.workspace': ['close'],
  'lorebook.enhanced.action': ['open'],
  'lorebook.enhanced.workspace': ['close'],
})

function validateLorebookWorkspacePayload(props: HostSurfaceProps): void {
  const state = props.state
  if (!isPlainRecord(state)) throw new Error('HOST_SURFACE_PROPS_INVALID:lorebook workspace state required')
  const keys = Object.keys(state)
  const allowed = new Set(['open', 'bookId', 'entryId', 'invocationId', 'source'])
  if (keys.some(key => !allowed.has(key))) throw new Error('HOST_SURFACE_PROPS_INVALID:lorebook workspace state unknown field')
  if (typeof state.open !== 'boolean') throw new Error('HOST_SURFACE_PROPS_INVALID:lorebook workspace state.open required')
  if (state.source !== undefined && !['entry_table', 'half_editor', 'settings'].includes(String(state.source))) {
    throw new Error('HOST_SURFACE_PROPS_INVALID:lorebook workspace state.source')
  }
  for (const key of ['bookId', 'entryId', 'invocationId'] as const) {
    const value = state[key]
    if (value !== null && (typeof value !== 'string' || value.length > 128)) {
      throw new Error(`HOST_SURFACE_PROPS_INVALID:lorebook workspace state.${key}`)
    }
  }
}

function validateProductivitySurfacePayload(surfaceId: string, props: HostSurfaceProps): void {
  const allowed = PRODUCTIVITY_CAPABILITIES[surfaceId] ?? []
  const capabilities = props.capabilities
  if (!Array.isArray(capabilities) || capabilities.some(capability => !allowed.includes(capability))) {
    throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}: capability mismatch`)
  }
  if (surfaceId === 'lorebook.half.workspace' || surfaceId === 'lorebook.enhanced.workspace') {
    validateLorebookWorkspacePayload(props)
  }
}

const HOST_SURFACE_ROWS: readonly HostSurfaceRow[] = Object.freeze([
  {
    id: 'message_preview',
    schema: {
      chatId: { kind: 'string', required: true, max: 128 },
      messageId: { kind: 'string', required: true, max: 128 },
      swipeIndex: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
      start: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
      end: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
    },
    propsSchema: '{ chatId: string, messageId: string, swipeIndex?: number, start?: number, end?: number }',
    validate(props) {
      if (!props.chatId || !props.messageId || (typeof props.start === 'number' && typeof props.end === 'number' && props.end < props.start)) {
        throw new Error('HOST_SURFACE_PROPS_INVALID:message_preview: invalid identity or range')
      }
    },
  },
  {
    id: 'provider_icon',
    schema: {
      provider: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      size: { kind: 'number', min: 8, max: 128, int: true },
    },
    propsSchema: '{ provider: string, size?: number }',
  },
  {
    id: 'world_book_entry_editor',
    schema: {
      bookId: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      entryId: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      density: { kind: 'string', enum: ['default', 'compact'] },
      fillContent: { kind: 'boolean' },
    },
    propsSchema: "{ bookId: string, entryId: string, density?: 'default'|'compact', fillContent?: boolean }",
  },
  {
    id: 'world_book_entry_table',
    schema: {
      bookId: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      selectedEntryId: { kind: 'string', max: 64, pattern: IDENTIFIER_PATTERN },
      density: { kind: 'string', enum: ['default', 'compact'] },
    },
    propsSchema: "{ bookId: string, selectedEntryId?: string, density?: 'default'|'compact' }",
  },
  {
    id: 'character_card',
    schema: {
      characterId: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      batchMode: { kind: 'boolean' },
      isSelected: { kind: 'boolean' },
    },
    propsSchema: '{ characterId: string, batchMode?: boolean, isSelected?: boolean }',
  },
  {
    id: 'character_library_grid',
    schema: {
      scope: { kind: 'string', enum: ['mine', 'shared'] },
      chatId: { kind: 'string', max: 64, pattern: IDENTIFIER_PATTERN },
      filterTab: { kind: 'string', max: 32 },
      sortField: { kind: 'string', max: 32 },
      sortDirection: { kind: 'string', enum: ['asc', 'desc'] },
      viewMode: { kind: 'string', max: 32 },
      search: { kind: 'string', max: 256 },
      excludeTags: { kind: 'string[]', maxItems: 64, maxLength: 128 },
      characters: { kind: 'object[]', maxItems: 100 },
      selectedCharacterId: { kind: 'string', max: 64, pattern: IDENTIFIER_PATTERN },
    },
    propsSchema: "{ scope?: 'mine'|'shared', chatId?, filterTab?, sortField?, sortDirection?, viewMode?, search?, excludeTags?, selectedCharacterId?, characters?: object[] }",
  },
  {
    id: 'character_preview_panel',
    schema: {
      characterId: { kind: 'string', required: true, max: 64, pattern: IDENTIFIER_PATTERN },
      imageHeight: { kind: 'number', min: 64, max: 4096, int: true },
      pinned: { kind: 'boolean' },
    },
    propsSchema: '{ characterId: string, imageHeight?: number, pinned?: boolean }',
  },
  {
    id: 'homepage_character_library',
    schema: {},
    propsSchema: '{}',
  },
  {
    id: 'token_count_button',
    schema: {
      text: { kind: 'string', required: true, max: MAX_STRING_LENGTH },
      profileId: { kind: 'string', max: 64, pattern: IDENTIFIER_PATTERN },
    },
    propsSchema: '{ text: string, profileId?: string }',
  },
  ...([
    'productivity.settings.workspace',
    'quick_toolbar.workspace',
    'connections_picker.launcher',
    'connections_picker.panel',
    'activated_lore.indicator',
    'activated_lore.panel',
    'portrait_dock.workspace',
    'lorebook.half.action',
    'lorebook.half.workspace',
    'lorebook.enhanced.action',
    'lorebook.enhanced.workspace',
  ] as const).map((id) => ({
    id,
    schema: PRODUCTIVITY_SURFACE_SCHEMA,
    propsSchema: '{ contractVersion: 1, ownerToken: string, generation: number, capabilities: string[], state?: object }',
    validate: props => validateProductivitySurfacePayload(id, props),
  })),
])

const HOST_SURFACE_ROWS_BY_ID = new Map(HOST_SURFACE_ROWS.map((row) => [row.id, row]))
const HOST_SURFACE_RENDERERS = new Map<string, HostSurfaceRenderer>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function isDomValue(value: object): boolean {
  if (typeof Node !== 'undefined' && value instanceof Node) return true
  if (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement) return true
  return false
}

function assertDataProperty(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}.${key}: enumerable data property required`)
  }
  return descriptor.value
}

function assertJsonValue(value: unknown, path: string, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: depth limit exceeded`)
  if (value === null) return

  switch (typeof value) {
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: finite number required`)
      return
    case 'string':
      if (value.length > MAX_STRING_LENGTH) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: string limit exceeded`)
      return
    case 'function':
    case 'undefined':
    case 'symbol':
    case 'bigint':
      throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: JSON value required`)
    default:
      break
  }

  if (typeof value !== 'object' || isDomValue(value)) {
    throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: unsupported object`)
  }
  if (seen.has(value)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: cyclic value`)
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: custom prototype`)
      }
      if (value.length > MAX_ARRAY_LENGTH) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: array limit exceeded`)
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || !keys.includes('length')) {
        throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: sparse or extra array fields`)
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!keys.includes(String(index))) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: sparse array`)
        assertJsonValue(assertDataProperty(value, String(index), path), `${path}[${index}]`, depth + 1, seen)
      }
      return
    }

    if (!isPlainRecord(value)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: custom prototype`)
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_OBJECT_KEYS) throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: object key limit exceeded`)
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error(`HOST_SURFACE_PROPS_INVALID:${path}: symbol keys are forbidden`)
      assertJsonValue(assertDataProperty(value, key, path), `${path}.${key}`, depth + 1, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function validatePropsSpec(surfaceId: string, schema: Readonly<Record<string, PropSpec>>, props: unknown): HostSurfaceProps {
  assertJsonValue(props, 'props', 0, new WeakSet())
  if (!isPlainRecord(props)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}: object props required`)

  const keys = Object.keys(props)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}: unknown prop ${key}`)
    }
  }

  const result: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    const descriptor = Object.getOwnPropertyDescriptor(props, key)
    if (!descriptor) {
      if (spec.required) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}: missing prop ${key}`)
      continue
    }
    const raw = assertDataProperty(props, key, surfaceId)
    switch (spec.kind) {
      case 'string':
        if (typeof raw !== 'string') throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: string required`)
        if (spec.max !== undefined && raw.length > spec.max) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: length limit exceeded`)
        if (spec.pattern && !spec.pattern.test(raw)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: pattern mismatch`)
        if (spec.enum && !spec.enum.includes(raw)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: enum mismatch`)
        result[key] = raw
        break
      case 'number':
        if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: finite number required`)
        if (spec.int && !Number.isInteger(raw)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: integer required`)
        if (spec.min !== undefined && raw < spec.min) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: below minimum`)
        if (spec.max !== undefined && raw > spec.max) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: above maximum`)
        result[key] = raw
        break
      case 'boolean':
        if (typeof raw !== 'boolean') throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: boolean required`)
        result[key] = raw
        break
      case 'string[]':
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
          throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: string array required`)
        }
        if (spec.maxItems !== undefined && raw.length > spec.maxItems) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: item limit exceeded`)
        if (spec.maxLength !== undefined && raw.some((item) => item.length > spec.maxLength!)) {
          throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: item length limit exceeded`)
        }
        result[key] = raw
        break
      case 'object[]':
        if (!Array.isArray(raw) || raw.some((item) => !isPlainRecord(item))) {
          throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: plain object array required`)
        }
        if (spec.maxItems !== undefined && raw.length > spec.maxItems) {
          throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: item limit exceeded`)
        }
        result[key] = raw
        break
      case 'object':
        if (!isPlainRecord(raw)) throw new Error(`HOST_SURFACE_PROPS_INVALID:${surfaceId}.${key}: plain object required`)
        result[key] = raw
        break
    }
  }
  return result as HostSurfaceProps
}

export function validateHostSurfaceProps(surfaceId: string, props: unknown): HostSurfaceProps {
  const row = HOST_SURFACE_ROWS_BY_ID.get(surfaceId)
  if (!row) throw new Error(`HOST_SURFACE_UNKNOWN:${surfaceId}`)
  const validated = validatePropsSpec(surfaceId, row.schema, props)
  row.validate?.(validated)
  return validated
}

export function validateHostSurfaceEventPayload(value: unknown): HostSurfaceJsonValue {
  assertJsonValue(value, 'event', 0, new WeakSet())
  return value as HostSurfaceJsonValue
}

export function listHostSurfaces(): readonly SpindleHostSurfaceInfo[] {
  return Object.freeze(HOST_SURFACE_ROWS.map((row) => {
    const authority = frontendAuthorityRow('host_surface', row.id)
    return Object.freeze({ id: row.id, permission: authority.permission, propsSchema: row.propsSchema })
  }))
}

export function hostSurfacePermission(surfaceId: string): string | null {
  if (!HOST_SURFACE_ROWS_BY_ID.has(surfaceId)) throw new Error(`HOST_SURFACE_UNKNOWN:${surfaceId}`)
  return frontendAuthorityRow('host_surface', surfaceId).permission
}

export function registerHostSurfaceRenderer(id: string, renderer: HostSurfaceRenderer): () => void {
  if (!HOST_SURFACE_ROWS_BY_ID.has(id)) throw new Error(`HOST_SURFACE_UNKNOWN:${id}`)
  if (typeof renderer !== 'function') throw new Error(`HOST_SURFACE_RENDERER_INVALID:${id}`)
  if (HOST_SURFACE_RENDERERS.has(id)) throw new Error(`HOST_SURFACE_DUPLICATE_RENDERER:${id}`)
  HOST_SURFACE_RENDERERS.set(id, renderer)
  let active = true
  return () => {
    if (!active) return
    active = false
    if (HOST_SURFACE_RENDERERS.get(id) === renderer) HOST_SURFACE_RENDERERS.delete(id)
  }
}

export function getHostSurfaceRenderer(id: string): HostSurfaceRenderer | undefined {
  if (!HOST_SURFACE_ROWS_BY_ID.has(id)) throw new Error(`HOST_SURFACE_UNKNOWN:${id}`)
  return HOST_SURFACE_RENDERERS.get(id)
}
