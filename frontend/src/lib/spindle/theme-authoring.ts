import type { SpindleUploadFile } from 'lumiverse-spindle-types'
import type { ThemeAsset } from '@/types/api'
import { sanitizeCSS, validateCSS } from '@/lib/cssValidator'
import { disableImportedThemePackTsx } from '@/lib/componentOverrideSecurity'
import { componentSelector } from '@/lib/componentRegistryJoin'
import { toThemeAssetRelativePath } from '@/lib/themeAssetCss'
import {
  createThemePack,
  decodeThemePackArchive,
  encodeThemePackArchive,
  type ThemePack,
  type ThemePackAsset,
} from '@/lib/themePack'

export const THEME_AUTHORING_HOST_CAPABILITIES = Object.freeze({
  'theme-assets-v1': 1,
  'theme-packs-v1': 1,
  'theme-catalog-v1': 1,
  'theme-editor-navigation-v1': 1,
} as const)

export interface SpindleThemeAsset {
  id: string
  bundleId: string
  slug: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  tags?: string[]
  metadata?: Record<string, unknown>
  cssPath: string
  contentUrl: string
}

export interface SpindleThemeAssetUploadOptions {
  bundleId: string
  slug?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface SpindleThemeAssetUpdate {
  slug?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface SpindleThemePackComponentDraft { css: string; enabled?: boolean }
export interface SpindleThemePackDraft {
  name: string
  author?: string
  description?: string
  globalCSS: string
  components?: Record<string, SpindleThemePackComponentDraft>
  assetBundleId?: string | null
}
export interface SpindleThemePackImportResult {
  draft: SpindleThemePackDraft
  assets: SpindleThemeAsset[]
  warnings: string[]
}
export interface SpindleThemePackInstallOptions { apply?: boolean; saveToLibrary?: boolean }
export interface SpindleThemePackInstallResult {
  bundleId: string
  applied: boolean
  savedToLibrary: boolean
  savedThemeId?: string
  assetCount: number
  componentCount: number
}
export interface SpindleThemeComponentCatalogEntry {
  id: string
  label: string
  category: string
  selector: string
  hasCss: boolean
  hasTsx: boolean
}
export interface SpindleThemeVariableCatalogEntry {
  name: string
  defaultValue?: string
  value?: string
  category?: string
}
export type SpindleThemeEditorTarget = 'global' | 'assets' | 'component'
export interface SpindleThemeEditorOptions { target?: SpindleThemeEditorTarget; componentId?: string }

export interface SpindleThemeAuthoringAPI {
  readonly assets: {
    getActiveBundleId(): string | null
    createBundle(): string
    list(bundleId: string): Promise<SpindleThemeAsset[]>
    upload(file: SpindleUploadFile, options: SpindleThemeAssetUploadOptions): Promise<SpindleThemeAsset>
    update(assetId: string, patch: SpindleThemeAssetUpdate): Promise<SpindleThemeAsset>
    delete(assetId: string): Promise<void>
    optimizeWebp(assetId: string): Promise<SpindleThemeAsset>
    getBytes(assetId: string): Promise<Uint8Array>
  }
  readonly packs: {
    exportDraft(draft: SpindleThemePackDraft): Promise<Uint8Array>
    importArchive(bytes: Uint8Array): Promise<SpindleThemePackImportResult>
    installDraft(draft: SpindleThemePackDraft, options?: SpindleThemePackInstallOptions): Promise<SpindleThemePackInstallResult>
  }
  readonly catalog: {
    listComponents(): readonly SpindleThemeComponentCatalogEntry[]
    listVariables(): readonly SpindleThemeVariableCatalogEntry[]
  }
  openEditor(options?: SpindleThemeEditorOptions): boolean
}

interface ThemeAssetClient {
  list(bundleId: string): Promise<ThemeAsset[]>
  upload(file: File, input: SpindleThemeAssetUploadOptions): Promise<ThemeAsset>
  update(id: string, input: SpindleThemeAssetUpdate): Promise<ThemeAsset>
  optimizeWebp(id: string): Promise<ThemeAsset>
  delete(id: string): Promise<void>
  getBlob(id: string): Promise<Blob>
  contentUrl(id: string): string
}

interface ThemeAuthoringStore {
  customCSS: { bundleId: string | null }
  applyThemePack(pack: ThemePack): void
  addSavedTheme(input: { kind: 'pack'; name: string; pack: ThemePack }): { id: string }
  setCustomCSSEditorSession(patch: {
    selected?: string
    activeTab?: 'css' | 'tsx'
    showAssets?: boolean
    showReference?: boolean
  }): void
  openModal(name: string): void
}

export interface ThemeComponentRegistryEntry {
  component: string
  category: string
  cssPath: string | null
  tsxPath: string | null
}

export interface ThemeAuthoringDependencies {
  assertActive(): void
  requireAppManipulation(member: string): void
  assetClient: ThemeAssetClient
  getStore(): ThemeAuthoringStore
  createBundleId(): string
  componentCatalog: readonly ThemeComponentRegistryEntry[]
  variableCatalog: Readonly<Record<string, string>>
  computedValue(name: string): string | undefined
}

const MUTATING_MEMBERS = {
  upload: 'ctx.theme.assets.upload',
  update: 'ctx.theme.assets.update',
  delete: 'ctx.theme.assets.delete',
  optimizeWebp: 'ctx.theme.assets.optimizeWebp',
  importArchive: 'ctx.theme.packs.importArchive',
  installDraft: 'ctx.theme.packs.installDraft',
} as const

function toPublicAsset(asset: ThemeAsset, client: ThemeAssetClient): SpindleThemeAsset {
  return {
    id: asset.id,
    bundleId: asset.bundle_id,
    slug: asset.slug,
    originalFilename: asset.original_filename,
    mimeType: asset.mime_type,
    sizeBytes: asset.byte_size,
    tags: [...(asset.tags ?? [])],
    metadata: { ...(asset.metadata ?? {}) },
    cssPath: toThemeAssetRelativePath(asset.slug),
    contentUrl: client.contentUrl(asset.id),
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function base64ToFile(asset: ThemePackAsset): File {
  const binary = atob(asset.dataBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new File([bytes], asset.originalFilename, { type: asset.mimeType })
}

function prepareStylesheet(label: string, css: string, warnings?: string[]): string {
  const sanitized = sanitizeCSS(css)
  if (sanitized !== css) warnings?.push(`${label} contained unsafe external CSS constructs that were removed.`)
  const result = validateCSS(sanitized)
  if (!result.valid) throw new Error(`INVALID_THEME_CSS:${label}: ${result.error ?? 'CSS could not be parsed'}`)
  return sanitized
}

function prepareDraft(draft: SpindleThemePackDraft, warnings?: string[]): SpindleThemePackDraft {
  const components = Object.fromEntries(Object.entries(draft.components ?? {}).map(([id, component]) => [id, {
    css: prepareStylesheet(`component ${id}`, component.css, warnings),
    enabled: component.enabled ?? true,
  }]))
  return {
    name: draft.name.trim().slice(0, 200) || 'Untitled Theme',
    author: draft.author?.slice(0, 200),
    description: draft.description?.slice(0, 5000),
    globalCSS: prepareStylesheet('global CSS', draft.globalCSS, warnings),
    components,
    assetBundleId: draft.assetBundleId ?? null,
  }
}

async function readPackAssets(bundleId: string | null | undefined, client: ThemeAssetClient): Promise<ThemePackAsset[]> {
  if (!bundleId) return []
  const assets = await client.list(bundleId)
  return Promise.all(assets.map(async (asset) => ({
    slug: asset.slug,
    originalFilename: asset.original_filename,
    mimeType: asset.mime_type,
    tags: [...(asset.tags ?? [])],
    metadata: { ...(asset.metadata ?? {}) },
    dataBase64: await blobToBase64(await client.getBlob(asset.id)),
  })))
}

function draftToPack(draft: SpindleThemePackDraft, bundleId: string, assets: ThemePackAsset[]): ThemePack {
  return createThemePack(
    null,
    { css: draft.globalCSS, enabled: !!draft.globalCSS.trim(), revision: Date.now(), bundleId },
    Object.fromEntries(Object.entries(draft.components ?? {}).map(([id, component]) => [id, {
      css: component.css,
      tsx: '',
      enabled: component.enabled ?? true,
    }])),
    assets,
    { name: draft.name, author: draft.author, description: draft.description },
  )
}

async function uploadPackAssets(
  packAssets: readonly ThemePackAsset[],
  bundleId: string,
  client: ThemeAssetClient,
): Promise<SpindleThemeAsset[]> {
  const uploaded: ThemeAsset[] = []
  try {
    for (const asset of packAssets) {
      uploaded.push(await client.upload(base64ToFile(asset), {
        bundleId,
        slug: asset.slug,
        tags: asset.tags,
        metadata: asset.metadata,
      }))
    }
  } catch (error) {
    await Promise.all(uploaded.map((asset) => client.delete(asset.id).catch(() => {})))
    throw error
  }
  return uploaded.map((asset) => toPublicAsset(asset, client))
}

function variableCategory(name: string): string | undefined {
  const match = name.match(/^--(?:lumiverse|lcs)-([a-z]+)/i)
  return match?.[1]
}

export function createThemeAuthoringAPI(dependencies: ThemeAuthoringDependencies): SpindleThemeAuthoringAPI {
  const { assetClient } = dependencies
  const active = () => dependencies.assertActive()
  const mutate = (member: string) => { active(); dependencies.requireAppManipulation(member) }

  return Object.freeze({
    assets: Object.freeze({
      getActiveBundleId() { active(); return dependencies.getStore().customCSS.bundleId },
      createBundle() { active(); return dependencies.createBundleId() },
      async list(bundleId) { active(); return (await assetClient.list(bundleId)).map((asset) => toPublicAsset(asset, assetClient)) },
      async upload(file, options) {
        mutate(MUTATING_MEMBERS.upload)
        if (file.bytes.byteLength !== file.sizeBytes) throw new Error('INVALID_UPLOAD_FILE:sizeBytes does not match bytes')
        const browserFile = new File([Uint8Array.from(file.bytes)], file.name, { type: file.mimeType })
        return toPublicAsset(await assetClient.upload(browserFile, options), assetClient)
      },
      async update(assetId, patch) { mutate(MUTATING_MEMBERS.update); return toPublicAsset(await assetClient.update(assetId, patch), assetClient) },
      async delete(assetId) { mutate(MUTATING_MEMBERS.delete); await assetClient.delete(assetId) },
      async optimizeWebp(assetId) { mutate(MUTATING_MEMBERS.optimizeWebp); return toPublicAsset(await assetClient.optimizeWebp(assetId), assetClient) },
      async getBytes(assetId) { active(); return new Uint8Array(await (await assetClient.getBlob(assetId)).arrayBuffer()) },
    }),
    packs: Object.freeze({
      async exportDraft(input) {
        active()
        const draft = prepareDraft(input)
        const assets = await readPackAssets(draft.assetBundleId, assetClient)
        return encodeThemePackArchive(draftToPack(draft, draft.assetBundleId ?? dependencies.createBundleId(), assets))
      },
      async importArchive(bytes) {
        mutate(MUTATING_MEMBERS.importArchive)
        const decoded = decodeThemePackArchive(Uint8Array.from(bytes))
        if (decoded.error) throw new Error(`INVALID_THEME_ARCHIVE:${decoded.error.code}: ${decoded.error.message}`)
        const warnings: string[] = []
        const unsafeTsxCount = Object.values(decoded.pack.components).filter((component) => component.tsx.trim()).length
        const secured = disableImportedThemePackTsx(decoded.pack).pack
        if (unsafeTsxCount) warnings.push(`${unsafeTsxCount} component TSX override${unsafeTsxCount === 1 ? ' was' : 's were'} omitted and left disabled.`)
        const draft = prepareDraft({
          name: secured.name,
          author: secured.author,
          description: secured.description,
          globalCSS: secured.globalCSS,
          components: Object.fromEntries(Object.entries(secured.components).map(([id, component]) => [id, {
            css: component.css,
            enabled: component.enabled,
          }])),
          assetBundleId: dependencies.createBundleId(),
        }, warnings)
        const assets = await uploadPackAssets(secured.assets, draft.assetBundleId!, assetClient)
        return { draft, assets, warnings }
      },
      async installDraft(input, options: SpindleThemePackInstallOptions = {}) {
        mutate(MUTATING_MEMBERS.installDraft)
        const draft = prepareDraft(input)
        const bundleId = dependencies.createBundleId()
        const sourceAssets = await readPackAssets(draft.assetBundleId, assetClient)
        const installedAssets = await uploadPackAssets(sourceAssets, bundleId, assetClient)
        const pack = draftToPack(draft, bundleId, sourceAssets)
        const store = dependencies.getStore()
        const applied = options.apply ?? true
        if (applied) store.applyThemePack(pack)
        let savedThemeId: string | undefined
        if (options.saveToLibrary) savedThemeId = store.addSavedTheme({ kind: 'pack', name: pack.name, pack }).id
        return {
          bundleId,
          applied,
          savedToLibrary: !!options.saveToLibrary,
          savedThemeId,
          assetCount: installedAssets.length,
          componentCount: Object.keys(pack.components).length,
        }
      },
    }),
    catalog: Object.freeze({
      listComponents() {
        active()
        return Object.freeze(dependencies.componentCatalog.map((entry) => Object.freeze({
          id: entry.component,
          label: entry.component,
          category: entry.category,
          selector: componentSelector(entry.component),
          hasCss: !!entry.cssPath,
          hasTsx: !!entry.tsxPath,
        })))
      },
      listVariables() {
        active()
        return Object.freeze(Object.entries(dependencies.variableCatalog).map(([name, defaultValue]) => Object.freeze({
          name,
          defaultValue,
          value: dependencies.computedValue(name),
          category: variableCategory(name),
        })))
      },
    }),
    openEditor(options: SpindleThemeEditorOptions = {}) {
      active()
      const target = options.target ?? 'global'
      if (target === 'component' && !dependencies.componentCatalog.some((entry) => entry.component === options.componentId)) return false
      const store = dependencies.getStore()
      store.setCustomCSSEditorSession(target === 'component'
        ? { selected: options.componentId!, activeTab: 'css', showAssets: false }
        : { selected: '__global__', activeTab: 'css', showAssets: target === 'assets' })
      store.openModal('customCSS')
      return true
    },
  })
}
