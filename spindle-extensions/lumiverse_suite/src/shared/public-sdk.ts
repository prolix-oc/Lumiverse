import type { SpindleMountPoint } from 'lumiverse-spindle-types'

/** Host-provided mount or decorator root. DOM work must stay inside this node. */
export type ScopedHostRoot = HTMLElement

/** Widen host mount ids that 0.6.12's published SpindleMountPoint union does not name yet. */
export function asMount(id: string): SpindleMountPoint {
  return id as SpindleMountPoint
}

/** Local stand-in; 0.6.12 does not export this handle type. */
export type SpindleHostSurfaceHandle = {
  update: (p?: unknown) => void
  destroy: () => void
  on?: (...a: unknown[]) => () => void
}

/** Local stand-in; 0.6.12 does not export this handle type. */
export type SpindleSettingsTabHandle = {
  id?: string
  root?: HTMLElement
  update?: (p?: unknown) => void
  destroy: () => void
}

export function isScopedHostRoot(value: unknown): value is ScopedHostRoot {
  if (!value || typeof value !== 'object') return false
  const node = value as { nodeType?: unknown; querySelectorAll?: unknown; append?: unknown }
  return node.nodeType === 1
    && typeof node.querySelectorAll === 'function'
    && typeof node.append === 'function'
}

export function requireScopedHostRoot(value: unknown, code: string): ScopedHostRoot {
  if (!isScopedHostRoot(value)) throw new Error(code)
  return value
}

export function ownerDocumentOf(root: ScopedHostRoot): Document | undefined {
  return root.ownerDocument ?? undefined
}

export function readExtensionInstallationId(ctx: {
  readonly host?: { readonly extensionInstallationId?: string }
  readonly extensionInstallationId?: string
}): string | undefined {
  const nested = ctx.host?.extensionInstallationId
  if (typeof nested === 'string' && nested.length > 0) return nested
  const direct = ctx.extensionInstallationId
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

export function bookIdFromScopedRow(row: ScopedHostRoot): string | undefined {
  let current: Element | null = row
  while (current) {
    if (current instanceof HTMLElement) {
      const bookId = current.dataset.worldBookEntriesBookId
      if (bookId) return bookId
    }
    current = current.parentElement
  }
  return undefined
}
