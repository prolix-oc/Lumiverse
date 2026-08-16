export const FRONTEND_PROVIDER_SCOPE = 'frontend'

export type ProviderRegistryChangeAction = 'add' | 'remove' | 'change'
export type ProviderRegistryAction = ProviderRegistryChangeAction | 'snapshot'

export interface ProviderRegistryChangedPayload {
  userId: string
  scope: string
  action: ProviderRegistryAction
  generation: number
  revision: number
  payload: unknown
}

export interface ProviderRegistryEntry {
  id: string
  [key: string]: unknown
}

export interface ProviderRegistryProjectionOptions {
  authorizedUserId: string
  authorizedScope?: string
}

export type ProviderRegistryApplyResult = 'applied' | 'queued' | 'ignored'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readProviderId(payload: unknown): string | null {
  const rec = asRecord(payload)
  if (!rec) return null
  if (typeof rec.id === 'string' && rec.id.length > 0) return rec.id
  if (typeof rec.providerId === 'string' && rec.providerId.length > 0) return rec.providerId
  return null
}

function readSnapshotProviders(payload: unknown): ProviderRegistryEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : asRecord(payload)?.providers
  if (!Array.isArray(list)) return []
  const out: ProviderRegistryEntry[] = []
  for (const item of list) {
    const id = readProviderId(item)
    if (!id) continue
    out.push({ ...(asRecord(item) ?? {}), id })
  }
  return out
}

export class ProviderRegistryProjection {
  readonly authorizedUserId: string
  readonly authorizedScope: string

  private generation = 0
  private revision = 0
  private awaitingResync = false
  private pending: ProviderRegistryChangedPayload[] = []
  private providers = new Map<string, ProviderRegistryEntry>()

  constructor(options: ProviderRegistryProjectionOptions) {
    this.authorizedUserId = options.authorizedUserId
    this.authorizedScope = options.authorizedScope ?? FRONTEND_PROVIDER_SCOPE
  }

  getGeneration(): number {
    return this.generation
  }

  getRevision(): number {
    return this.revision
  }

  isAwaitingResync(): boolean {
    return this.awaitingResync
  }

  list(): ProviderRegistryEntry[] {
    return [...this.providers.values()]
  }

  /**
   * Hold change events until an authoritative snapshot lands. Idempotent
   * while already awaiting so a second CONNECTED cannot drop the queue.
   */
  beginReconnectResync(): void {
    if (this.awaitingResync) return
    this.awaitingResync = true
    this.pending = []
  }

  applyEvent(event: ProviderRegistryChangedPayload): ProviderRegistryApplyResult {
    if (!this.isAuthorized(event)) return 'ignored'
    if (!Number.isFinite(event.generation) || !Number.isFinite(event.revision)) return 'ignored'

    if (event.action === 'snapshot') {
      return this.applySnapshot(event)
    }
    if (event.action !== 'add' && event.action !== 'remove' && event.action !== 'change') {
      return 'ignored'
    }
    if (this.awaitingResync) {
      this.pending.push(event)
      return 'queued'
    }
    return this.applyChanged(event)
  }

  private isAuthorized(event: ProviderRegistryChangedPayload): boolean {
    if (typeof event.userId !== 'string' || event.userId !== this.authorizedUserId) return false
    if (typeof event.scope !== 'string' || event.scope !== this.authorizedScope) return false
    return true
  }

  private isStale(generation: number, revision: number): boolean {
    if (generation < this.generation) return true
    if (generation === this.generation && revision <= this.revision) return true
    return false
  }

  private applySnapshot(event: ProviderRegistryChangedPayload): ProviderRegistryApplyResult {
    if (this.isStale(event.generation, event.revision)) return 'ignored'

    this.providers.clear()
    for (const entry of readSnapshotProviders(event.payload)) {
      this.providers.set(entry.id, entry)
    }
    this.generation = event.generation
    this.revision = event.revision
    this.awaitingResync = false

    const queued = this.pending
    this.pending = []
    for (const next of queued) {
      this.applyEvent(next)
    }
    return 'applied'
  }

  private applyChanged(event: ProviderRegistryChangedPayload): ProviderRegistryApplyResult {
    if (this.isStale(event.generation, event.revision)) return 'ignored'

    const id = readProviderId(event.payload)
    if (!id) return 'ignored'

    if (event.action === 'remove') {
      this.providers.delete(id)
    } else {
      const rec = asRecord(event.payload) ?? {}
      this.providers.set(id, { ...rec, id })
    }

    this.generation = event.generation
    this.revision = event.revision
    return 'applied'
  }
}

export function createProviderRegistryProjection(
  options: ProviderRegistryProjectionOptions,
): ProviderRegistryProjection {
  return new ProviderRegistryProjection(options)
}
