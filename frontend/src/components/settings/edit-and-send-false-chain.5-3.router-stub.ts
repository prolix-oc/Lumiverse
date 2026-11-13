/**
 * TEST SUPPORT — spec task 5.3 Edit-and-Send false-setting value-chain runtime test.
 *
 * `react-router` alias used ONLY by
 * `edit-and-send-false-chain.5-3.vite.isolated.tsx` (its own Vite server).
 * `useMessageCard` calls `useNavigate()` and the branch path calls the returned
 * navigate function, so the harness must be able to OBSERVE navigation rather
 * than mock away the behaviour under test. Every navigate argument is recorded
 * in `navigateCalls`; the boundary-4 assertion ("preload and navigation are
 * skipped") reads that log.
 *
 * No production code and no real router module is modified.
 */

export const navigateCalls: unknown[][] = []

export function resetNavigateCalls(): void {
  navigateCalls.length = 0
}

export function useNavigate() {
  return (...args: unknown[]) => {
    navigateCalls.push(args)
    return undefined
  }
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
