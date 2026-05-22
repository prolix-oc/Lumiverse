/**
 * Dynamic component registry — auto-discovered via import.meta.glob.
 *
 * Globs all *.module.css and *.tsx files under src/components/ (plus App,
 * LandingPage, LoginPage).  Pairs them by path so each entry knows both
 * its stylesheet and its source component file.
 *
 * Zero maintenance: new components are picked up automatically on rebuild.
 */

// ── Glob discovery (lazy — no import cost, just path enumeration) ────
const cssModulePaths = Object.keys(
  import.meta.glob('/src/**/*.module.css', { eager: false }),
)
const tsxPaths = Object.keys(
  import.meta.glob('/src/**/*.tsx', { eager: false }),
)

// ── Helpers ──────────────────────────────────────────────────────────

/** Derive a human-readable component name from a file path. */
function nameFromPath(p: string): string {
  const filename = p.split('/').pop()!
  return filename.replace(/\.(module\.css|tsx)$/, '')
}

/** Map directory segments to a display category. */
function categoryFromPath(p: string): string {
  // Strip leading /src/components/ or /src/
  const rel = p.replace(/^\/src\/components\//, '').replace(/^\/src\//, '')
  const seg = rel.split('/')[0]

  const map: Record<string, string> = {
    chat: 'Chat',
    panels: 'Panels',
    modals: 'Modals',
    shared: 'Shared',
    settings: 'Settings',
    spindle: 'Spindle',
    auth: 'Auth',
    landing: 'Landing',
  }

  // Sub-directories inside panels (e.g. panels/theme-panel, panels/custom-css)
  if (seg === 'panels') {
    const sub = rel.split('/')[1]
    if (sub?.includes('-')) {
      // panels/theme-panel/AccentPicker → "Theme"
      const label = sub.replace(/-/g, ' ').replace(/\bpanel\b/i, '').trim()
      if (label) return label.charAt(0).toUpperCase() + label.slice(1)
    }
  }

  // Top-level files like App.module.css
  if (!p.includes('/components/')) return 'App'

  return map[seg] || seg.charAt(0).toUpperCase() + seg.slice(1)
}

// ── Build the registry ──────────────────────────────────────────────

export interface CSSModuleEntry {
  /** PascalCase component name derived from file path */
  component: string
  /** Display category derived from directory structure */
  category: string
  /** Path to the .module.css file */
  cssPath: string
  /** Path to the corresponding .tsx file (if found) */
  tsxPath: string | null
}

/**
 * Paths that are excluded from the override registry to prevent
 * self-referential overrides (overriding the editor breaks the editor)
 * or security-sensitive component overrides.
 */
const EXCLUDED_PATHS = [
  // Theme editor infrastructure — self-referential override would brick the UI
  '/custom-css/',
  '/modals/CustomCSSModal',
  '/modals/PropsReference',
  // Auth — overriding login could capture credentials
  '/auth/',
  // Modal infrastructure — overriding shells could break all modals
  '/shared/ModalShell',
  '/shared/ErrorBoundary',
  // Settings/operator — could expose admin controls
  '/settings/AccountSettings',
  '/settings/OperatorPanel',
  '/settings/UserManagement',
]

function isExcluded(path: string): boolean {
  return EXCLUDED_PATHS.some((p) => path.includes(p))
}

function buildRegistry(): CSSModuleEntry[] {
  // Index tsx files by their derived component name + directory for pairing
  const tsxByKey = new Map<string, string>()
  for (const p of tsxPaths) {
    const name = nameFromPath(p)
    const dir = p.substring(0, p.lastIndexOf('/'))
    tsxByKey.set(`${dir}/${name}`, p)
  }

  const entries: CSSModuleEntry[] = []
  const seen = new Set<string>()

  for (const cssPath of cssModulePaths) {
    // Skip excluded paths
    if (isExcluded(cssPath)) continue

    const component = nameFromPath(cssPath)

    // Skip duplicates (shouldn't happen, but guard)
    const key = `${categoryFromPath(cssPath)}:${component}`
    if (seen.has(key)) continue
    seen.add(key)

    // Try to find the matching .tsx in the same directory
    const dir = cssPath.substring(0, cssPath.lastIndexOf('/'))
    const tsxPath = tsxByKey.get(`${dir}/${component}`) ?? null

    entries.push({
      component,
      category: categoryFromPath(cssPath),
      cssPath,
      tsxPath,
    })
  }

  // Sort: categories alphabetically, components alphabetically within
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.component.localeCompare(b.component))

  return entries
}

export const CSS_MODULE_REGISTRY: readonly CSSModuleEntry[] = buildRegistry()

/** Generate a CSS selector for targeting a component via data-component. */
export function generateSelector(entry: CSSModuleEntry, part?: string): string {
  const base = `[data-component="${entry.component}"]`
  if (part) return `${base}[data-part="${part}"]`
  return base
}
