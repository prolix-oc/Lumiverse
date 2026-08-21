import { beforeAll, describe, expect, test } from 'bun:test'
import type { ThemeAsset } from '@/types/api'
import { createThemePack, decodeThemePackArchive, encodeThemePackArchive } from '@/lib/themePack'
import {
  createThemeAuthoringAPI,
  THEME_AUTHORING_HOST_CAPABILITIES,
  type ThemeAuthoringDependencies,
} from './theme-authoring'

beforeAll(() => {
  if (typeof CSSStyleSheet === 'undefined') {
    ;(globalThis as any).CSSStyleSheet = class { replaceSync(_css: string) {} }
  }
})

function nativeAsset(id: string, bundleId: string, slug = 'assets/portrait.png', sizeBytes = 3): ThemeAsset {
  return {
    id,
    bundle_id: bundleId,
    slug,
    storage_type: 'file',
    image_id: null,
    file_name: slug,
    original_filename: slug,
    mime_type: 'image/png',
    byte_size: sizeBytes,
    tags: ['theme'],
    metadata: { role: 'portrait' },
    created_at: 1,
    updated_at: 1,
  }
}

function fixture() {
  let nextId = 0
  const assets = new Map<string, ThemeAsset>()
  const blobs = new Map<string, Blob>()
  const applied: any[] = []
  const saved: any[] = []
  const sessions: any[] = []
  const modals: string[] = []
  const permissionChecks: string[] = []
  const initial = nativeAsset('asset-source', 'source-bundle')
  assets.set(initial.id, initial)
  blobs.set(initial.id, new Blob([Uint8Array.from([1, 2, 3])], { type: initial.mime_type }))

  const assetClient = {
    async list(bundleId: string) { return [...assets.values()].filter((asset) => asset.bundle_id === bundleId) },
    async upload(file: File, input: { bundleId: string; slug?: string; tags?: string[]; metadata?: Record<string, unknown> }) {
      const id = `uploaded-${++nextId}`
      const requestedSlug = input.slug ?? file.name
      const asset = nativeAsset(id, input.bundleId, requestedSlug.startsWith('assets/') ? requestedSlug : `assets/${requestedSlug}`, file.size)
      asset.original_filename = file.name
      asset.mime_type = file.type
      asset.tags = [...(input.tags ?? [])]
      asset.metadata = { ...(input.metadata ?? {}) }
      assets.set(id, asset)
      blobs.set(id, file)
      return asset
    },
    async update(id: string, patch: { slug?: string; tags?: string[]; metadata?: Record<string, unknown> }) {
      const current = assets.get(id)!
      const next = { ...current, slug: patch.slug ?? current.slug, tags: patch.tags ?? current.tags, metadata: patch.metadata ?? current.metadata }
      assets.set(id, next)
      return next
    },
    async optimizeWebp(id: string) { return assets.get(id)! },
    async delete(id: string) { assets.delete(id); blobs.delete(id) },
    async getBlob(id: string) { return blobs.get(id)! },
    contentUrl(id: string) { return `/api/v1/theme-assets/${id}/content` },
  }
  const store = {
    customCSS: { bundleId: 'active-bundle' as string | null },
    applyThemePack(pack: any) { applied.push(pack) },
    addSavedTheme(input: any) { saved.push(input); return { id: `saved-${saved.length}` } },
    setCustomCSSEditorSession(patch: any) { sessions.push(patch) },
    openModal(name: string) { modals.push(name) },
  }
  const dependencies: ThemeAuthoringDependencies = {
    assertActive() {},
    requireAppManipulation(member) { permissionChecks.push(member) },
    assetClient,
    getStore: () => store,
    createBundleId: () => `bundle-${++nextId}`,
    componentCatalog: [{ component: 'BubbleMessage', category: 'Chat', cssPath: '/private/BubbleMessage.module.css', tsxPath: '/private/BubbleMessage.tsx' }],
    variableCatalog: { '--lumiverse-primary': '#9370db' },
    computedValue: (name) => name === '--lumiverse-primary' ? 'rgb(147, 112, 219)' : undefined,
  }
  return { api: createThemeAuthoringAPI(dependencies), dependencies, assets, applied, saved, sessions, modals, permissionChecks }
}

describe('Spindle native theme authoring bridge', () => {
  test('advertises each independently feature-detectable capability', () => {
    expect(THEME_AUTHORING_HOST_CAPABILITIES).toEqual({
      'theme-assets-v1': 1,
      'theme-packs-v1': 1,
      'theme-catalog-v1': 1,
      'theme-editor-navigation-v1': 1,
    })
  })

  test('returns both canonical CSS paths and authenticated preview URLs', async () => {
    const { api } = fixture()
    const [asset] = await api.assets.list('source-bundle')
    expect(asset.cssPath).toBe('./assets/portrait.png')
    expect(asset.contentUrl).toBe('/api/v1/theme-assets/asset-source/content')
  })

  test('uploads SpindleUploadFile bytes through the native File client', async () => {
    const { api, permissionChecks } = fixture()
    const uploaded = await api.assets.upload({ name: 'font.woff2', mimeType: 'font/woff2', sizeBytes: 4, bytes: Uint8Array.from([1, 2, 3, 4]) }, { bundleId: 'fonts', slug: 'font.woff2' })
    expect(uploaded.sizeBytes).toBe(4)
    expect(uploaded.cssPath).toBe('./assets/font.woff2')
    expect(permissionChecks).toContain('ctx.theme.assets.upload')
  })

  test('exports drafts through the canonical archive codec', async () => {
    const { api } = fixture()
    const bytes = await api.packs.exportDraft({ name: 'Studio Theme', globalCSS: ':root { --demo: 1; }', assetBundleId: 'source-bundle' })
    const decoded = decodeThemePackArchive(bytes)
    expect(decoded.error).toBeUndefined()
    if (decoded.error) return
    expect(decoded.pack.name).toBe('Studio Theme')
    expect(decoded.pack.theme).toBeNull()
    expect(decoded.pack.assets).toHaveLength(1)
  })

  test('imports into a fresh bundle without applying or exposing executable TSX', async () => {
    const { api, applied, permissionChecks } = fixture()
    const pack = createThemePack(null, { css: '.global {}', enabled: true, revision: 1, bundleId: 'archive' }, {
      BubbleMessage: { css: '.bubble {}', tsx: 'return <script />', enabled: true },
    }, [], { name: 'Imported' })
    const result = await api.packs.importArchive(encodeThemePackArchive(pack))
    expect(result.draft.assetBundleId).toStartWith('bundle-')
    expect(result.draft.components?.BubbleMessage).toEqual({ css: '.bubble {}', enabled: false })
    expect(result.warnings.join(' ')).toContain('TSX')
    expect(applied).toHaveLength(0)
    expect(permissionChecks).toContain('ctx.theme.packs.importArchive')
  })

  test('installs a safe pack with a fresh bundle and optional library save', async () => {
    const { api, applied, saved } = fixture()
    const result = await api.packs.installDraft({
      name: 'Installed',
      globalCSS: '.global {}',
      components: { BubbleMessage: { css: '.bubble {}' } },
      assetBundleId: 'source-bundle',
    }, { apply: true, saveToLibrary: true })
    expect(result.bundleId).toStartWith('bundle-')
    expect(result.bundleId).not.toBe('source-bundle')
    expect(result).toMatchObject({ applied: true, savedToLibrary: true, assetCount: 1, componentCount: 1, savedThemeId: 'saved-1' })
    expect(applied[0].components.BubbleMessage).toEqual({ css: '.bubble {}', tsx: '', enabled: true })
    expect(saved).toHaveLength(1)
  })

  test('catalog projections contain selectors but never source paths', () => {
    const { api } = fixture()
    const [component] = api.catalog.listComponents()
    expect(component).toEqual({ id: 'BubbleMessage', label: 'BubbleMessage', category: 'Chat', selector: '[data-component="BubbleMessage"]', hasCss: true, hasTsx: true })
    expect(component).not.toHaveProperty('cssPath')
    expect(component).not.toHaveProperty('tsxPath')
    expect(api.catalog.listVariables()[0]).toMatchObject({ name: '--lumiverse-primary', defaultValue: '#9370db', value: 'rgb(147, 112, 219)' })
  })

  test('opens supported native editor locations and rejects unknown components', () => {
    const { api, sessions, modals } = fixture()
    expect(api.openEditor({ target: 'assets' })).toBeTrue()
    expect(sessions[0]).toMatchObject({ selected: '__global__', activeTab: 'css', showAssets: true })
    expect(modals).toEqual(['customCSS'])
    expect(api.openEditor({ target: 'component', componentId: 'Missing' })).toBeFalse()
  })

  test('mutating methods fail cleanly when app manipulation is absent', async () => {
    const setup = fixture()
    setup.dependencies.requireAppManipulation = () => { throw new Error('PERMISSION_DENIED:app_manipulation') }
    const api = createThemeAuthoringAPI(setup.dependencies)
    await expect(api.assets.delete('asset-source')).rejects.toThrow('PERMISSION_DENIED:app_manipulation')
    await expect(api.packs.installDraft({ name: 'Nope', globalCSS: '' })).rejects.toThrow('PERMISSION_DENIED:app_manipulation')
  })
})
