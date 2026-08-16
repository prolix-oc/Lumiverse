import { Component, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

/**
 * Spindle presentation/shell overrides. Separate from theme `store.componentOverrides`.
 */
export const SPINDLE_OVERRIDE_HOSTS = [
  'BubbleMessage',
  'MinimalMessage',
  'MessageEditArea',
  'InputArea',
  'PortraitPanel',
  'QuickToolbar',
  'ConnectionsPicker',
  'CharacterCard',
  'LoomBuilder',
  'LandingPageShell',
  'CommandPalette',
] as const

export type SpindleOverrideHost = (typeof SPINDLE_OVERRIDE_HOSTS)[number]
export type SpindleOverrideMode = 'wrap' | 'replace'

/** Replace is allowed only when every native callback is forwarded. */
export const SPINDLE_CALLBACK_REQUIRED_HOSTS = new Set<SpindleOverrideHost>([
  'MessageEditArea',
  'InputArea',
])

export interface SpindleComponentOverrideProps<P extends object = object> {
  Original?: ComponentType<Partial<P>>
}

export interface SpindleComponentOverrideRegistrationInput<P extends object = object> {
  readonly host: SpindleOverrideHost
  readonly owner: string
  readonly generation: number
  readonly mode: SpindleOverrideMode
  readonly priority?: number
  readonly component: ComponentType<P & SpindleComponentOverrideProps<P>>
}

export interface SpindleComponentOverrideRegistration<P extends object = object> {
  readonly id: string
  readonly host: SpindleOverrideHost
  readonly owner: string
  readonly generation: number
  readonly mode: SpindleOverrideMode
  readonly priority: number
  readonly sequence: number
  readonly component: ComponentType<P & SpindleComponentOverrideProps<P>>
}

export interface SpindleComponentOverrideHandle {
  readonly id: string
  readonly host: SpindleOverrideHost
  readonly owner: string
  readonly generation: number
  readonly mode: SpindleOverrideMode
  readonly priority: number
  readonly sequence: number
  destroy(): void
}

type RegistryListener = () => void

const HOST_SET = new Set<string>(SPINDLE_OVERRIDE_HOSTS)
const registrations: SpindleComponentOverrideRegistration[] = []
const ownerGenerationKeys = new Set<string>()
const listeners = new Set<RegistryListener>()
let sequence = 0
let epoch = 0

function notify(): void {
  epoch += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // Observer isolation: one subscriber cannot block unload or another registration.
    }
  }
}

function requireHost(host: string): SpindleOverrideHost {
  if (!HOST_SET.has(host)) throw new Error(`COMPONENT_OVERRIDE_HOST_INVALID:${host}`)
  return host as SpindleOverrideHost
}

function requireOwner(owner: string): string {
  if (typeof owner !== 'string' || owner.trim().length === 0) {
    throw new Error('COMPONENT_OVERRIDE_OWNER_INVALID')
  }
  return owner.trim()
}

function requireGeneration(generation: number): number {
  if (!Number.isFinite(generation)) throw new Error('COMPONENT_OVERRIDE_GENERATION_INVALID')
  return generation
}

function ownerGenerationKey(owner: string, generation: number, host: SpindleOverrideHost): string {
  return `${owner}:${generation}:${host}`
}

function sortOverrides(
  entries: readonly SpindleComponentOverrideRegistration[],
): SpindleComponentOverrideRegistration[] {
  return [...entries].sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
}

export function getComponentOverrideEpoch(): number {
  return epoch
}

export function subscribeComponentOverrides(listener: RegistryListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getComponentOverrides(host?: SpindleOverrideHost): readonly SpindleComponentOverrideRegistration[] {
  const entries = host === undefined ? registrations : registrations.filter((entry) => entry.host === host)
  return Object.freeze(sortOverrides(entries))
}

export function resolveComponentOverride(host: SpindleOverrideHost): SpindleComponentOverrideRegistration | null {
  return getComponentOverrides(host)[0] ?? null
}

export function registerComponentOverride<P extends object>(
  input: SpindleComponentOverrideRegistrationInput<P>,
): SpindleComponentOverrideHandle {
  const host = requireHost(input.host)
  const owner = requireOwner(input.owner)
  const generation = requireGeneration(input.generation)
  if (input.mode !== 'wrap' && input.mode !== 'replace') {
    throw new Error(`COMPONENT_OVERRIDE_MODE_INVALID:${String(input.mode)}`)
  }
  if (typeof input.component !== 'function') {
    throw new Error('COMPONENT_OVERRIDE_COMPONENT_INVALID')
  }

  const key = ownerGenerationKey(owner, generation, host)
  if (ownerGenerationKeys.has(key)) {
    throw new Error(`COMPONENT_OVERRIDE_DUPLICATE:${owner}:${generation}`)
  }

  const registration: SpindleComponentOverrideRegistration<P> = Object.freeze({
    id: `${owner}:${generation}:${host}:${sequence + 1}`,
    host,
    owner,
    generation,
    mode: input.mode,
    priority: Number.isFinite(input.priority) ? input.priority! : 100,
    sequence: ++sequence,
    component: input.component,
  })

  ownerGenerationKeys.add(key)
  registrations.push(registration as SpindleComponentOverrideRegistration)
  notify()

  let destroyed = false
  return {
    id: registration.id,
    host: registration.host,
    owner: registration.owner,
    generation: registration.generation,
    mode: registration.mode,
    priority: registration.priority,
    sequence: registration.sequence,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      unregisterComponentOverride(registration.id)
    },
  }
}

export function unregisterComponentOverride(id: string): void {
  const index = registrations.findIndex((entry) => entry.id === id)
  if (index === -1) return
  const [removed] = registrations.splice(index, 1)
  if (removed) ownerGenerationKeys.delete(ownerGenerationKey(removed.owner, removed.generation, removed.host))
  notify()
}

export function clearComponentOverridesForOwner(owner: string, generation?: number): void {
  let changed = false
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const entry = registrations[index]
    if (!entry) continue
    if (entry.owner !== owner) continue
    if (generation !== undefined && entry.generation !== generation) continue
    registrations.splice(index, 1)
    ownerGenerationKeys.delete(ownerGenerationKey(entry.owner, entry.generation, entry.host))
    changed = true
  }
  if (changed) notify()
}

export function resetComponentOverrideRegistryForTests(): void {
  registrations.splice(0)
  ownerGenerationKeys.clear()
  sequence = 0
  notify()
}

export function isCallbackProp(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

export function pickSafeOverrideProps<P extends object>(
  host: SpindleOverrideHost,
  props: P,
  mode: SpindleOverrideMode,
): Partial<P> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (isCallbackProp(value)) {
      if (mode === 'wrap' || SPINDLE_CALLBACK_REQUIRED_HOSTS.has(host)) safe[key] = value
      continue
    }
    safe[key] = value
  }
  return safe as Partial<P>
}

export function retainsNativeCallbacks(
  nativeProps: Record<string, unknown>,
  outgoingProps: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(nativeProps)) {
    if (isCallbackProp(value) && outgoingProps[key] !== value) return false
  }
  return true
}

interface ErrorBoundaryProps {
  host: SpindleOverrideHost
  resetKey: string
  fallback: ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

class SpindleOverrideErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error(`[SpindleOverride] ${this.props.host} crashed:`, error)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

export function renderSpindleOverride<P extends object>(
  host: SpindleOverrideHost,
  DefaultComponent: ComponentType<P>,
  props: P,
): ReactElement {
  const override = resolveComponentOverride(host)
  const native = <DefaultComponent {...props} />
  if (!override) return native

  const safeProps = pickSafeOverrideProps(host, props, override.mode)
  if (
    override.mode === 'replace'
    && SPINDLE_CALLBACK_REQUIRED_HOSTS.has(host)
    && !retainsNativeCallbacks(props as Record<string, unknown>, safeProps as Record<string, unknown>)
  ) {
    return native
  }

  function Original(slotProps: Partial<P> = {} as Partial<P>) {
    return <DefaultComponent {...props} {...slotProps} />
  }

  const Override = override.component as ComponentType<P & SpindleComponentOverrideProps<P>>
  const frozen = Object.freeze({
    ...safeProps,
    ...(override.mode === 'wrap' ? { Original } : {}),
  }) as P & SpindleComponentOverrideProps<P>

  return (
    <SpindleOverrideErrorBoundary host={host} resetKey={override.id} fallback={native}>
      <Override {...frozen} />
    </SpindleOverrideErrorBoundary>
  )
}
