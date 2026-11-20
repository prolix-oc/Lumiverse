/**
 * TEST SUPPORT — spec task 5.2 runtime streaming-continuity regression tests.
 *
 * `react-router` alias used ONLY by
 * `streaming-continuity.5-2.vite.isolated.tsx` (its own Vite server).
 * The real card components reach `useMessageCard`, which calls `useNavigate()`,
 * and `BubbleMessageDefault` / `MinimalMessageDefault` reach router-aware
 * helpers. A Router provider is irrelevant to render continuity, so the router
 * surface is stubbed inside the test's own module graph. No production code and
 * no real router module is touched.
 */

export function useNavigate() {
  return (..._args: unknown[]) => undefined
}

export function useParams() {
  return {} as Record<string, string>
}

export function useLocation() {
  return { pathname: '/', search: '', hash: '', state: null, key: 'harness' }
}

export function useSearchParams() {
  return [new URLSearchParams(), () => undefined] as const
}

export function Link(props: { children?: unknown }) {
  return props.children ?? null
}

export function NavLink(props: { children?: unknown }) {
  return props.children ?? null
}

export function Outlet() {
  return null
}

export function Navigate() {
  return null
}

export function RouterProvider(props: { children?: unknown }) {
  return props.children ?? null
}

export function MemoryRouter(props: { children?: unknown }) {
  return props.children ?? null
}

export function BrowserRouter(props: { children?: unknown }) {
  return props.children ?? null
}

export function createBrowserRouter(routes: unknown) {
  return {
    routes,
    state: { location: { pathname: '/', search: '', hash: '', state: null, key: 'harness' } },
    navigate: () => Promise.resolve(),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  }
}

export function useRouteError() {
  return null
}

export function useNavigation() {
  return { state: 'idle' as const }
}
