/**
 * TEST SUPPORT — spec task 5.4 rendered oldest-message ownership matrix.
 *
 * `react-router` alias used ONLY by
 * `oldest-message-ownership.5-4.vite.isolated.tsx` (its own Vite server).
 * The real `ChatView` calls `useParams()`/`useNavigate()`, and the real
 * QuickToolbar action catalog reaches `router.navigate`. A Router provider is
 * irrelevant to the render-gate question, so the router surface is stubbed
 * inside the test's own module graph and every navigation is RECORDED rather
 * than swallowed, so "navigation behaviour is preserved" stays an observation.
 * No production code and no real router module is touched.
 */

export const navigateCalls: unknown[][] = []

export function resetNavigateCalls(): void {
  navigateCalls.length = 0
}

export function useNavigate() {
  return (...args: unknown[]) => {
    navigateCalls.push(args)
  }
}

let params: Record<string, string> = { chatId: 'chat-1' }

export function setParams(next: Record<string, string>): void {
  params = next
}

export function useParams() {
  return params
}

export function useLocation() {
  return { pathname: '/chat/chat-1', search: '', hash: '', state: null, key: 'harness' }
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
    state: { location: { pathname: '/chat/chat-1', search: '', hash: '', state: null, key: 'harness' } },
    navigate: (...args: unknown[]) => {
      navigateCalls.push(args)
      return Promise.resolve()
    },
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
