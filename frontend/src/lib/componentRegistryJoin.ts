/** Shared naming, exclusion, and path-joining rules for the CSS component registry. */
export const EXCLUDED_PATHS = [
  '/custom-css/',
  '/modals/CustomCSSModal',
  '/modals/PropsReference',
  '/auth/',
  '/shared/ModalShell',
  '/shared/ErrorBoundary',
  '/settings/AccountSettings',
  '/settings/OperatorPanel',
  '/settings/UserManagement',
] as const

export interface ComponentRegistryJoinEntry {
  component: string
  category: string
  cssPath: string | null
  tsxPath: string | null
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Return a stable path rooted at the workspace `src/` directory. */
function sourceRelativePath(path: string): string {
  const normalized = normalizePath(path)
  const sourceMarker = '/src/'
  const sourceIndex = normalized.lastIndexOf(sourceMarker)
  if (sourceIndex >= 0) return normalized.slice(sourceIndex + 1)
  if (normalized.startsWith('src/')) return normalized
  return normalized.replace(/^\/+/, '')
}

export function componentKeyFromPath(path: string): string {
  const filename = normalizePath(path).split('/').pop() ?? ''
  return filename.replace(/\.module\.css$|\.tsx$/, '')
}

/** Stable identity for a component path, independent of slash style or workspace root. */
export function componentRegistryKeyFromPath(path: string): string {
  const relative = sourceRelativePath(path)
  const directoryEnd = relative.lastIndexOf('/')
  const directory = directoryEnd >= 0 ? relative.slice(0, directoryEnd) : ''
  const component = componentKeyFromPath(relative)
  return directory ? `${directory}/${component}` : component
}

export function categoryFromPath(path: string): string {
  const normalized = normalizePath(path)
  const componentsMarker = '/src/components/'
  const componentsIndex = normalized.lastIndexOf(componentsMarker)
  let relative: string
  if (componentsIndex >= 0) {
    relative = normalized.slice(componentsIndex + componentsMarker.length)
  } else if (normalized.startsWith('src/components/')) {
    relative = normalized.slice('src/components/'.length)
  } else {
    return 'App'
  }
  const segments = relative.split('/')
  const root = segments[0]
  const categories: Record<string, string> = {
    chat: 'Chat', panels: 'Panels', modals: 'Modals', shared: 'Shared',
    settings: 'Settings', spindle: 'Spindle', auth: 'Auth', landing: 'Landing',
  }
  if (root === 'panels' && segments[1]?.includes('-')) {
    const label = segments[1].replace(/-/g, ' ').replace(/\bpanel\b/i, '').trim()
    if (label) return label.charAt(0).toUpperCase() + label.slice(1)
  }
  return categories[root] ?? root.charAt(0).toUpperCase() + root.slice(1)
}

export function isExcludedPath(path: string): boolean {
  const normalized = normalizePath(path)
  return EXCLUDED_PATHS.some((excluded) => normalized.includes(excluded))
}

/**
 * Join CSS and TSX paths by their canonical directory/component identity.
 * The first path on either side owns the output position; unmatched paths are
 * retained as CSS-only or TSX-only rows instead of being dropped.
 */
export function joinComponentRegistryPaths(
  cssPaths: readonly string[],
  tsxPaths: readonly string[],
): ComponentRegistryJoinEntry[] {
  const joined = new Map<string, ComponentRegistryJoinEntry>()

  const add = (path: string, side: 'cssPath' | 'tsxPath'): void => {
    const key = componentRegistryKeyFromPath(path)
    const existing = joined.get(key)
    if (existing) {
      if (existing[side] === null) existing[side] = path
      return
    }
    joined.set(key, {
      component: componentKeyFromPath(path),
      category: categoryFromPath(path),
      cssPath: side === 'cssPath' ? path : null,
      tsxPath: side === 'tsxPath' ? path : null,
    })
  }

  for (const path of cssPaths) add(path, 'cssPath')
  for (const path of tsxPaths) add(path, 'tsxPath')
  return [...joined.values()]
}

export function componentSelector(name: string, part?: string): string {
  const base = `[data-component="${name}"]`
  return part ? `${base}[data-part="${part}"]` : base
}
