/**
 * Dynamic component registry — auto-discovered via import.meta.glob.
 *
 * CSS and TSX paths are paired through the canonical join shared with the
 * props extractor. Keeping one path identity rule prevents Windows slash
 * differences and TSX-only siblings from silently changing the pairing.
 */

import {
  componentSelector,
  isExcludedPath,
  joinComponentRegistryPaths,
  type ComponentRegistryJoinEntry,
} from './componentRegistryJoin'

// Vite replaces these calls in production. The guard keeps non-Vite host
// contract tests and SSR-like consumers from evaluating an unavailable API.
const cssModulePaths = typeof import.meta.glob === 'function'
  ? Object.keys(import.meta.glob('/src/**/*.module.css', { eager: false }))
  : []
const tsxPaths = typeof import.meta.glob === 'function'
  ? Object.keys(import.meta.glob('/src/**/*.tsx', { eager: false }))
  : []

export type CSSModuleEntry = Omit<ComponentRegistryJoinEntry, 'cssPath'> & { cssPath: string }

function buildRegistry(): CSSModuleEntry[] {
  const entries = joinComponentRegistryPaths(cssModulePaths, tsxPaths)
    .filter((entry): entry is CSSModuleEntry => (
      entry.cssPath !== null && !isExcludedPath(entry.cssPath)
    ))

  entries.sort((a, b) => (
    a.category.localeCompare(b.category) || a.component.localeCompare(b.component)
  ))
  return entries
}

export const CSS_MODULE_REGISTRY: readonly CSSModuleEntry[] = buildRegistry()

/** Generate a CSS selector for targeting a component via data-component. */
export function generateSelector(entry: CSSModuleEntry, part?: string): string {
  return componentSelector(entry.component, part)
}
