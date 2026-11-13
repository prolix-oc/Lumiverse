import { describe, expect, test } from 'bun:test'
import type { SpindleManifest } from 'lumiverse-spindle-types'
import { selectFrontendBundle, type WidgetFrontendManifest } from './frontend-bundle-selection'

const manifest = {
  identifier: 'example',
  version: '1.0.0',
  name: 'Example',
  author: 'Example',
  github: 'https://example.com',
  homepage: 'https://example.com',
  permissions: [],
  entry_frontend: 'dist/frontend.js',
  frontend_cache_key: 'full-key',
  entry_frontend_widget: 'dist/widget.js',
  frontend_widget_cache_key: 'widget-key',
} as WidgetFrontendManifest

describe('selectFrontendBundle', () => {
  test('selects the dedicated widget entry for a desktop widget', () => {
    expect(selectFrontendBundle(manifest, true)).toEqual({
      kind: 'widget',
      entry: 'dist/widget.js',
      endpoint: 'frontend/widget',
      cacheKey: 'widget-key',
    })
  })

  test('keeps the application entry outside a desktop widget', () => {
    expect(selectFrontendBundle(manifest, false)).toEqual({
      kind: 'application',
      entry: 'dist/frontend.js',
      endpoint: 'frontend',
      cacheKey: 'full-key',
    })
  })

  test('falls back for legacy manifests without a widget entry', () => {
    const legacy = { ...manifest, entry_frontend_widget: undefined } as SpindleManifest
    expect(selectFrontendBundle(legacy, true).kind).toBe('application')
  })
})
