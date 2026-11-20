import { useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import {
  UNSAFE_DataRouterContext,
  UNSAFE_DataRouterStateContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
} from 'react-router'

/**
 * Built-in drawer tab panels are mounted into their own detached React roots
 * via `createRoot` (see `drawer-tab-registry.tsx`) so their state survives tab
 * switches and re-parenting between drawers/containers. A separate React root
 * does NOT inherit context from the app's `<RouterProvider>` tree, so any panel
 * that calls `useNavigate()` / `useParams()` (e.g. the character gallery via
 * `useCharacterBrowser`) crashes with:
 *
 *   "useNavigate() may be used only in the context of a <Router> component."
 *
 * Rather than re-wiring every panel to navigate through the router singleton,
 * we bridge the live react-router contexts across the root boundary:
 *
 *   - `<RouterContextExporter/>` renders once inside the app tree (in `App`,
 *     alongside the `<Outlet/>`) and republishes the current context values.
 *   - `<RouterContextBridge>` wraps each detached root and re-provides those
 *     same values, so the router hooks resolve to the app's real router.
 *
 * Capturing at App level reproduces exactly what these panels saw before the
 * drawer-mobility refactor, when they rendered as App-level siblings of the
 * Outlet (so `useParams()` is empty and panels fall back to the store).
 */

type Captured = {
  dataRouter: React.ContextType<typeof UNSAFE_DataRouterContext>
  dataRouterState: React.ContextType<typeof UNSAFE_DataRouterStateContext>
  navigation: React.ContextType<typeof UNSAFE_NavigationContext>
  location: React.ContextType<typeof UNSAFE_LocationContext>
  route: React.ContextType<typeof UNSAFE_RouteContext>
}

let snapshot: Captured | null = null
const listeners = new Set<() => void>()

function publish(next: Captured): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): Captured | null {
  return snapshot
}

/**
 * Mirror the live react-router context values out of the app tree so detached
 * roots can bridge them back in. Renders nothing. Must live inside the app's
 * `<RouterProvider>` tree (we mount it in `App`).
 */
export function RouterContextExporter(): null {
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  const dataRouterState = useContext(UNSAFE_DataRouterStateContext)
  const navigation = useContext(UNSAFE_NavigationContext)
  const location = useContext(UNSAFE_LocationContext)
  const route = useContext(UNSAFE_RouteContext)

  // Publish before paint so a panel opened immediately after a route change
  // never reads a stale location.
  useLayoutEffect(() => {
    publish({ dataRouter, dataRouterState, navigation, location, route })
  }, [dataRouter, dataRouterState, navigation, location, route])

  return null
}

/**
 * Re-provide the captured react-router contexts inside a detached React root so
 * `useNavigate`/`useLocation`/`useParams`/`<Link>` resolve to the app router.
 * Before the exporter has captured (i.e. before `App` mounts), renders children
 * as-is — drawer panels are only mounted lazily on first open, well after that.
 */
export function RouterContextBridge({ children }: { children: ReactNode }): ReactNode {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!snap) return children
  return (
    <UNSAFE_DataRouterContext.Provider value={snap.dataRouter}>
      <UNSAFE_DataRouterStateContext.Provider value={snap.dataRouterState}>
        <UNSAFE_NavigationContext.Provider value={snap.navigation}>
          <UNSAFE_LocationContext.Provider value={snap.location}>
            <UNSAFE_RouteContext.Provider value={snap.route}>
              {children}
            </UNSAFE_RouteContext.Provider>
          </UNSAFE_LocationContext.Provider>
        </UNSAFE_NavigationContext.Provider>
      </UNSAFE_DataRouterStateContext.Provider>
    </UNSAFE_DataRouterContext.Provider>
  )
}
