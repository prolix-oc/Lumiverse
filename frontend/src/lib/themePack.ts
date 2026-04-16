import type { ThemeConfig } from '@/types/theme'
import type { ComponentOverride } from '@/lib/componentOverrides'
import type { CustomCSSSettings } from '@/types/store'

/** Portable theme pack — bundles all three override layers. */
export interface ThemePack {
  /** Schema version for forward compatibility */
  format: 1
  /** Pack metadata */
  name: string
  author: string
  description: string
  createdAt: number

  /** Layer 1: Theme config (colors, accent, mode, glass, radius, fonts) */
  theme: ThemeConfig | null
  /** Layer 2: Global CSS (non-component overrides) */
  globalCSS: string
  /** Layer 3: Per-component overrides (CSS + TSX per component) */
  components: Record<string, { css: string; tsx: string; enabled: boolean }>
}

const EXTENSION = '.lumiverse-theme'
const MIME = 'application/json'

/** Snapshot the current theme state into an exportable pack. */
export function createThemePack(
  theme: ThemeConfig | null,
  customCSS: CustomCSSSettings,
  componentOverrides: Record<string, ComponentOverride>,
  meta: { name?: string; author?: string; description?: string } = {},
): ThemePack {
  // Only include components that have actual content
  const components: ThemePack['components'] = {}
  for (const [name, override] of Object.entries(componentOverrides)) {
    if (override.css?.trim() || override.tsx?.trim()) {
      components[name] = {
        css: override.css || '',
        tsx: override.tsx || '',
        enabled: override.enabled,
      }
    }
  }

  return {
    format: 1,
    name: meta.name || 'Untitled Theme',
    author: meta.author || '',
    description: meta.description || '',
    createdAt: Math.floor(Date.now() / 1000),
    theme,
    globalCSS: customCSS.css || '',
    components,
  }
}

/** Validate that a parsed object looks like a theme pack. */
export function validateThemePack(data: any): data is ThemePack {
  return (
    typeof data === 'object' &&
    data !== null &&
    data.format === 1 &&
    typeof data.name === 'string' &&
    typeof data.createdAt === 'number' &&
    (data.theme === null || typeof data.theme === 'object') &&
    typeof data.globalCSS === 'string' &&
    typeof data.components === 'object'
  )
}

/** Download a theme pack as a .lumiverse-theme file. */
export function exportThemePack(pack: ThemePack): void {
  const json = JSON.stringify(pack, null, 2)
  const blob = new Blob([json], { type: MIME })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pack.name.toLowerCase().replace(/\s+/g, '-') || 'theme'}${EXTENSION}`
  a.click()
  URL.revokeObjectURL(url)
}

/** Prompt the user to select a .lumiverse-theme file and parse it. */
export function importThemePack(): Promise<ThemePack | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${EXTENSION},.json`
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (validateThemePack(data)) {
          resolve(data)
        } else {
          resolve(null)
        }
      } catch {
        resolve(null)
      }
    }
    // If user cancels the file picker
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** Summary of what a pack will change (for confirmation UI). */
export function packSummary(pack: ThemePack): string[] {
  const parts: string[] = []
  if (pack.theme) parts.push('Theme colors & settings')
  if (pack.globalCSS.trim()) parts.push('Global CSS overrides')
  const compCount = Object.keys(pack.components).length
  if (compCount > 0) parts.push(`${compCount} component override${compCount !== 1 ? 's' : ''}`)
  return parts
}
