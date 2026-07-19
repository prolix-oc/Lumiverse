import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { transpileComponent } from '@/lib/componentTranspiler'
import { HOST_SLOTS_PROP } from '@/lib/componentOverrideCapabilities'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import { isSafeThemeMode } from '@/lib/safeThemeMode'

/**
 * ErrorBoundary that falls back to the default component on crash.
 */
class OverrideErrorBoundary extends React.Component<
  { fallback: React.ReactNode; componentName: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.error(`[ComponentOverride] ${this.props.componentName} crashed:`, error)
    toast.error(i18n.t('common.toast.componentCrashed', { name: this.props.componentName }))
  }

  // Reset error state when the override source changes
  componentDidUpdate(prevProps: any) {
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

interface TranspileEntry {
  tsx: string
  component: React.ComponentType<any> | null
  error: string | null
}

/**
 * Cache transpiled components so we only re-transpile when source changes.
 * Keyed by component name, stores the source hash and compiled component.
 */
const transpileCache = new Map<string, TranspileEntry>()

function getCachedEntry(name: string, tsx: string): TranspileEntry | null {
  const cached = transpileCache.get(name)
  if (cached && cached.tsx === tsx) return cached
  return null
}

async function getOrTranspile(name: string, tsx: string): Promise<TranspileEntry> {
  const cached = transpileCache.get(name)
  if (cached && cached.tsx === tsx) return cached

  const result = await transpileComponent(tsx)
  const entry: TranspileEntry = { tsx, component: result.component, error: result.error }
  transpileCache.set(name, entry)

  if (result.error) {
    console.warn(`[ComponentOverride] ${name} transpile error:`, result.error)
  }

  return entry
}

/**
 * Hook that returns a wrapped component — either the user's override or the default.
 * The override also receives a trusted <Original /> slot containing the complete
 * default renderer, allowing safe additive decoration without rebuilding native
 * controls and behavior.
 *
 * Usage:
 * ```tsx
 * function BubbleMessage(props) {
 *   const overrideProps = buildOverrideProps(props)
 *   const Render = useComponentOverride('BubbleMessage', DefaultBubbleMessage, overrideProps)
 *   return <Render />
 * }
 * ```
 */
export function useComponentOverride<P extends Record<string, any>>(
  componentName: string,
  DefaultComponent: React.ComponentType<P>,
  overrideProps: any,
  defaultProps: P,
  /**
   * Host-trusted React elements keyed by slot tag name (e.g. `{ Content: <…/> }`).
   * The override author renders these by placing the matching slot tag
   * (`<Content />`) — they cannot read or forge this object from their source.
   */
  hostSlots?: Record<string, React.ReactNode>,
): React.ReactElement {
  const override = useStore((s) => s.componentOverrides?.[componentName])
  const safeThemeMode = isSafeThemeMode()
  const prevErrorRef = useRef<string | null>(null)

  const [compiled, setCompiled] = useState<TranspileEntry | null>(() => {
    if (safeThemeMode || !override?.enabled || !override.tsx.trim()) return null
    return getCachedEntry(componentName, override.tsx)
  })

  useEffect(() => {
    if (safeThemeMode || !override?.enabled || !override.tsx.trim()) {
      setCompiled(null)
      return
    }

    let cancelled = false
    getOrTranspile(componentName, override.tsx).then((entry) => {
      if (!cancelled) setCompiled(entry)
    })

    return () => { cancelled = true }
  }, [safeThemeMode, componentName, override?.enabled, override?.tsx])

  // Show transpile errors once (not on every render)
  useEffect(() => {
    if (compiled?.error && compiled.error !== prevErrorRef.current) {
      prevErrorRef.current = compiled.error
      toast.error(i18n.t('common.toast.overrideError', { name: componentName, error: compiled.error }))
    } else if (!compiled?.error) {
      prevErrorRef.current = null
    }
  }, [compiled?.error, componentName])

  if (compiled?.component) {
    const UserComponent = compiled.component
    const original = <DefaultComponent {...defaultProps} />
    // Freeze top-level props so user code can't reassign action callbacks.
    // Host slots ride along under a reserved key the interpreter reads directly
    // and never exposes to user scope (see FORBIDDEN_PROPERTY_NAMES).
    // Original is assigned last so callers cannot replace the native component.
    const frozenProps = Object.freeze({
      ...overrideProps,
      [HOST_SLOTS_PROP]: { ...hostSlots, Original: original },
    })
    return (
      <OverrideErrorBoundary
        componentName={componentName}
        fallback={original}
      >
        <UserComponent {...frozenProps} />
      </OverrideErrorBoundary>
    )
  }

  return <DefaultComponent {...defaultProps} />
}

/**
 * Lightweight pass-through override for Tier 2 components.
 *
 * Add one line to the top of any component to make it overridable:
 * ```tsx
 * export default function ChatView(props) {
 *   const overridden = useOverrideRender('ChatView', props)
 *   if (overridden) return overridden
 *   // ... existing code unchanged
 * }
 * ```
 *
 * The user's override receives the component's original props as-is.
 * No extraction, no props contract — just wrap and go.
 */
export function useOverrideRender(
  componentName: string,
  props: Record<string, any>,
): React.ReactElement | null {
  const override = useStore((s) => s.componentOverrides?.[componentName])
  const safeThemeMode = isSafeThemeMode()
  const prevErrorRef = useRef<string | null>(null)

  const [compiled, setCompiled] = useState<TranspileEntry | null>(() => {
    if (safeThemeMode || !override?.enabled || !override.tsx.trim()) return null
    return getCachedEntry(componentName, override.tsx)
  })

  useEffect(() => {
    if (safeThemeMode || !override?.enabled || !override.tsx.trim()) {
      setCompiled(null)
      return
    }

    let cancelled = false
    getOrTranspile(componentName, override.tsx).then((entry) => {
      if (!cancelled) setCompiled(entry)
    })

    return () => { cancelled = true }
  }, [safeThemeMode, componentName, override?.enabled, override?.tsx])

  useEffect(() => {
    if (compiled?.error && compiled.error !== prevErrorRef.current) {
      prevErrorRef.current = compiled.error
      toast.error(i18n.t('common.toast.overrideError', { name: componentName, error: compiled.error }))
    } else if (!compiled?.error) {
      prevErrorRef.current = null
    }
  }, [compiled?.error, componentName])

  if (!compiled?.component) return null

  const UserComponent = compiled.component
  // No ErrorBoundary fallback here — returns null on crash so the
  // caller's own code runs.  The OverrideErrorBoundary wraps and
  // catches; on error it renders null which triggers the fallback path.
  return (
    <OverrideFallbackBoundary componentName={componentName}>
      <UserComponent {...props} />
    </OverrideFallbackBoundary>
  )
}

/**
 * ErrorBoundary variant that renders null on crash (for pass-through overrides).
 * The calling component's normal code path runs as the fallback.
 */
class OverrideFallbackBoundary extends React.Component<
  { componentName: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.error(`[ComponentOverride] ${this.props.componentName} crashed:`, error)
    toast.error(i18n.t('common.toast.componentCrashed', { name: this.props.componentName }))
  }

  componentDidUpdate(prevProps: any) {
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}
