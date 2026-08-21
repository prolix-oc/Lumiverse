/**
 * The single frontend implementation of a host action.
 *
 * The websocket bridge and `ctx.host.surfaces.invoke()` must use this same
 * switch.  Keeping the switch free of store imports makes its validation
 * independently testable and prevents the two entry points from growing
 * subtly different navigation semantics.
 */

export const HOST_SURFACE_KINDS = [
  'drawer_tab',
  'settings_tab',
  'command',
  'route',
  'modal',
  'input_bar_action',
  'ext_command',
] as const

export type HostSurfaceKind = (typeof HOST_SURFACE_KINDS)[number]

export interface HostSurfaceRef {
  kind: HostSurfaceKind
  id: string
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type HostActionParams = Record<string, JsonValue>

export interface HostActionRuntime {
  openDrawer(id: string): void
  closeDrawer(): void
  openSettings(id: string, anchorId?: string): void
  closeSettings(): void
  openCommandPalette(): void
  closeCommandPalette(): void
  runCommand(id: string): void | Promise<void>
  navigate(path: string): void
  setEditingCharacterId(id: string): void
  openWorldBookEditor(id: string, entryId?: string): void
  invokeInputBarAction(id: string): void | Promise<void>
  invokeExtensionCommand(id: string): void
}

export const HOST_ACTION_UNMAPPED = 'HOST_ACTION_UNMAPPED'
export const HOST_ACTION_INVALID_PARAMS = 'HOST_ACTION_INVALID_PARAMS'
export const HOST_ACTION_INVALID_ROUTE = 'HOST_ACTION_INVALID_ROUTE'
export const HOST_ACTION_INVALID_ID = 'HOST_ACTION_INVALID_ID'

export const HOST_ROUTE_PATTERNS = Object.freeze([
  '/',
  '/chat/:chatId',
  '/characters',
  '/characters/:id',
] as const)

export const HOST_MODAL_IDS = Object.freeze(['character_editor', 'world_book_editor'] as const)

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isHostSurfaceKind(value: unknown): value is HostSurfaceKind {
  return typeof value === 'string' && (HOST_SURFACE_KINDS as readonly string[]).includes(value)
}

export function assertHostId(value: unknown, label = 'id'): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.includes('..') || value.includes('%2e')) {
    throw new Error(`${HOST_ACTION_INVALID_ID}:${label}`)
  }
}

function paramsObject(params: HostActionParams | undefined): HostActionParams {
  if (params === undefined) return {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${HOST_ACTION_INVALID_PARAMS}:object`)
  }
  return params
}

function only(params: HostActionParams, ...keys: string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw new Error(`${HOST_ACTION_INVALID_PARAMS}:${key}`)
  }
}

function assertDrawerTarget(value: JsonValue | undefined): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${HOST_ACTION_INVALID_PARAMS}:target`)
  const target = value as { kind?: unknown; id?: unknown; parentId?: unknown }
  if (typeof target.kind !== 'string' || target.kind.length < 1 || target.kind.length > 64) throw new Error(`${HOST_ACTION_INVALID_PARAMS}:target.kind`)
  if (typeof target.id !== 'string' || target.id.length < 1 || target.id.length > 128) throw new Error(`${HOST_ACTION_INVALID_PARAMS}:target.id`)
  if (target.parentId !== undefined && (typeof target.parentId !== 'string' || target.parentId.length > 128)) throw new Error(`${HOST_ACTION_INVALID_PARAMS}:target.parentId`)
}

function routePath(refId: string, params: HostActionParams): string {
  if (!(HOST_ROUTE_PATTERNS as readonly string[]).includes(refId)) {
    throw new Error(`${HOST_ACTION_INVALID_ROUTE}:${refId}`)
  }
  switch (refId) {
    case '/':
      only(params)
      return '/'
    case '/characters':
      only(params)
      return '/characters'
    case '/chat/:chatId':
      only(params, 'chatId')
      assertHostId(params.chatId, 'chatId')
      return `/chat/${encodeURIComponent(params.chatId)}`
    case '/characters/:id':
      only(params, 'id')
      assertHostId(params.id, 'id')
      return `/characters/${encodeURIComponent(params.id)}`
  }
}

/**
 * Apply one already-authorized action. Catalog membership and authority-map
 * lookup intentionally live in host-surfaces.ts; this function only owns the
 * action switch and its fail-closed parameter validation.
 */
export function applyHostAction(
  ref: HostSurfaceRef,
  rawParams: HostActionParams | undefined,
  runtime: HostActionRuntime,
): void | Promise<void> {
  if (!isHostSurfaceKind(ref?.kind) || typeof ref.id !== 'string' || !ref.id) {
    throw new Error(`${HOST_ACTION_UNMAPPED}:${String(ref?.kind)}:${String(ref?.id)}`)
  }

  const params = paramsObject(rawParams)
  switch (ref.kind) {
    case 'drawer_tab':
      only(params, 'target')
      assertDrawerTarget(params.target)
      runtime.openDrawer(ref.id)
      return
    case 'settings_tab':
      only(params, 'anchorId')
      if (params.anchorId !== undefined && (typeof params.anchorId !== 'string' || params.anchorId.length > 100)) {
        throw new Error(`${HOST_ACTION_INVALID_PARAMS}:anchorId`)
      }
      runtime.openSettings(ref.id, params.anchorId as string | undefined)
      return
    case 'command':
      only(params)
      return runtime.runCommand(ref.id)
    case 'route':
      runtime.navigate(routePath(ref.id, params))
      return
    case 'modal':
      if (ref.id !== 'character_editor' && ref.id !== 'world_book_editor') {
        throw new Error(`${HOST_ACTION_UNMAPPED}:modal:${ref.id}`)
      }
      if (ref.id === 'world_book_editor') only(params, 'id', 'entryId')
      else only(params, 'id')
      assertHostId(params.id, 'id')
      if (ref.id === 'character_editor') runtime.setEditingCharacterId(params.id)
      else if (ref.id === 'world_book_editor') {
        if (params.entryId !== undefined) assertHostId(params.entryId, 'entryId')
        runtime.openWorldBookEditor(params.id, params.entryId as string | undefined)
      }
      return
    case 'input_bar_action':
      only(params)
      return runtime.invokeInputBarAction(ref.id)
    case 'ext_command':
      only(params)
      runtime.invokeExtensionCommand(ref.id)
      return
  }
}
