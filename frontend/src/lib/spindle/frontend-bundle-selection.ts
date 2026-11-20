import type { SpindleManifest } from 'lumiverse-spindle-types'

export type WidgetFrontendManifest = SpindleManifest & {
  entry_frontend_widget?: string
  frontend_cache_key?: string
  frontend_widget_cache_key?: string
}

export interface FrontendBundleSelection {
  kind: 'application' | 'widget'
  entry: string
  endpoint: 'frontend' | 'frontend/widget'
  cacheKey?: string
}

/** Select the widget bundle only when the manifest explicitly provides one.
 * Legacy extensions keep their existing full-frontend setup path. */
export function selectFrontendBundle(
  manifest: SpindleManifest,
  preferWidgetBundle: boolean,
): FrontendBundleSelection {
  const extended = manifest as WidgetFrontendManifest
  if (
    preferWidgetBundle
    && typeof extended.entry_frontend_widget === 'string'
    && extended.entry_frontend_widget.trim().length > 0
  ) {
    return {
      kind: 'widget',
      entry: extended.entry_frontend_widget,
      endpoint: 'frontend/widget',
      cacheKey: typeof extended.frontend_widget_cache_key === 'string'
        ? extended.frontend_widget_cache_key
        : undefined,
    }
  }

  return {
    kind: 'application',
    entry: manifest.entry_frontend || 'dist/frontend.js',
    endpoint: 'frontend',
    cacheKey: typeof extended.frontend_cache_key === 'string'
      ? extended.frontend_cache_key
      : undefined,
  }
}
