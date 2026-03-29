import React, { useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { transpileComponent } from '@/lib/componentTranspiler'
import { toast } from '@/lib/toast'

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
    toast.error(`Custom ${this.props.componentName} crashed — falling back to default`)
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

/**
 * Cache transpiled components so we only re-transpile when source changes.
 * Keyed by component name, stores the source hash and compiled component.
 */
const transpileCache = new Map<string, { tsx: string; component: React.ComponentType<any> | null; error: string | null }>()

function getOrTranspile(name: string, tsx: string) {
  const cached = transpileCache.get(name)
  if (cached && cached.tsx === tsx) return cached

  const result = transpileComponent(tsx)
  const entry = { tsx, component: result.component, error: result.error }
  transpileCache.set(name, entry)

  if (result.error) {
    console.warn(`[ComponentOverride] ${name} transpile error:`, result.error)
  }

  return entry
}

/**
 * Hook that returns a wrapped component — either the user's override or the default.
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
): React.ReactElement {
  const override = useStore((s) => s.componentOverrides?.[componentName])
  const prevErrorRef = useRef<string | null>(null)

  const compiled = useMemo(() => {
    if (!override?.enabled || !override.tsx.trim()) return null
    return getOrTranspile(componentName, override.tsx)
  }, [componentName, override?.enabled, override?.tsx])

  // Show transpile errors once (not on every render)
  if (compiled?.error && compiled.error !== prevErrorRef.current) {
    prevErrorRef.current = compiled.error
    toast.error(`${componentName} override: ${compiled.error}`)
  } else if (!compiled?.error) {
    prevErrorRef.current = null
  }

  if (compiled?.component) {
    const UserComponent = compiled.component
    // Freeze top-level props so user code can't reassign action callbacks
    const frozenProps = Object.freeze({ ...overrideProps })
    return (
      <OverrideErrorBoundary
        componentName={componentName}
        fallback={<DefaultComponent {...defaultProps} />}
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
  const prevErrorRef = useRef<string | null>(null)

  const compiled = useMemo(() => {
    if (!override?.enabled || !override.tsx.trim()) return null
    return getOrTranspile(componentName, override.tsx)
  }, [componentName, override?.enabled, override?.tsx])

  if (compiled?.error && compiled.error !== prevErrorRef.current) {
    prevErrorRef.current = compiled.error
    toast.error(`${componentName} override: ${compiled.error}`)
  } else if (!compiled?.error) {
    prevErrorRef.current = null
  }

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
    toast.error(`Custom ${this.props.componentName} crashed — falling back to default`)
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
