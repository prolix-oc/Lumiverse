import type { ThemeConfig } from '@/types/theme'
import type { ComponentOverride } from '@/lib/componentOverrides'
import type { CustomCSSSettings } from '@/types/store'
import { generateUUID } from '@/lib/uuid'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** Portable theme pack — bundles all three override layers. */
export interface ThemePackAsset {
  slug: string
  originalFilename: string
  mimeType: string
  tags: string[]
  metadata: Record<string, unknown>
  dataBase64: string
}

interface ThemePackArchiveAsset {
  slug: string
  originalFilename: string
  mimeType: string
  tags: string[]
  metadata: Record<string, unknown>
  archivePath: string
}

interface ThemePackArchiveManifest {
  format: 3
  name: string
  author: string
  description: string
  createdAt: number
  bundleId: string
  theme: ThemeConfig | null
  globalCSS: string
  components: Record<string, { css: string; tsx: string; enabled: boolean }>
  assets: ThemePackArchiveAsset[]
}

export interface ThemePack {
  /** Schema version for forward compatibility */
  format: 2
  /** Pack metadata */
  name: string
  author: string
  description: string
  createdAt: number
  bundleId: string

  /** Layer 1: Theme config (colors, accent, mode, glass, radius, fonts) */
  theme: ThemeConfig | null
  /** Layer 2: Global CSS (non-component overrides) */
  globalCSS: string
  /** Layer 3: Per-component overrides (CSS + TSX per component) */
  components: Record<string, { css: string; tsx: string; enabled: boolean }>
  /** Bundled theme assets referenced via relative CSS URLs */
  assets: ThemePackAsset[]
}

export type ThemePackImportErrorCode =
  | 'missing-theme-json'
  | 'invalid-archive-layout'
  | 'unsupported-legacy-file'

export interface ThemePackImportError {
  code: ThemePackImportErrorCode
  message: string
}

export type ThemePackImportResult =
  | { pack: ThemePack; error?: undefined }
  | { pack?: undefined; error: ThemePackImportError }

interface LegacyThemePack {
  format: 1
  name: string
  author?: string
  description?: string
  createdAt: number
  theme: ThemeConfig | null
  globalCSS: string
  components: Record<string, { css: string; tsx: string; enabled: boolean }>
}

const EXTENSION = '.lumitheme'
const LEGACY_EXTENSION = '.lumiverse-theme'
const MIME = 'application/zip'
const THEME_JSON = 'theme.json'
const ZIP_SIGNATURE = [0x50, 0x4b]
const MAX_ARCHIVE_SIZE_BYTES = 200 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 250 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 500

function sanitizeString(value: unknown, fallback = '', maxLength = 5000): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, maxLength)
}

function sanitizeArchivePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) return null
  return normalized
}

function sanitizeAssetFileName(name: string): string {
  const normalized = sanitizeString(name || 'asset', 'asset', 180)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return normalized || 'asset'
}

function sanitizeAsset(asset: any): ThemePackAsset | null {
  if (!asset || typeof asset !== 'object') return null
  const slug = sanitizeString(asset.slug)
  const originalFilename = sanitizeString(asset.originalFilename, 'asset')
  const mimeType = sanitizeString(asset.mimeType, 'application/octet-stream', 255)
  const dataBase64 = sanitizeString(asset.dataBase64, '', 100 * 1024 * 1024)
  if (!slug || !dataBase64) return null
  return {
    slug,
    originalFilename,
    mimeType,
    tags: Array.isArray(asset.tags) ? asset.tags.filter((tag: unknown): tag is string => typeof tag === 'string').slice(0, 32) : [],
    metadata: asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) ? asset.metadata : {},
    dataBase64,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === ZIP_SIGNATURE[0] && bytes[1] === ZIP_SIGNATURE[1]
}

function importError(code: ThemePackImportErrorCode, message: string): ThemePackImportResult {
  return { error: { code, message } }
}

function normalizeArchiveManifest(data: any): ThemePackArchiveManifest | null {
  if (!data || typeof data !== 'object' || data.format !== 3) return null
  if (
    typeof data.name !== 'string' ||
    typeof data.createdAt !== 'number' ||
    typeof data.bundleId !== 'string' ||
    (data.theme !== null && typeof data.theme !== 'object') ||
    typeof data.globalCSS !== 'string' ||
    typeof data.components !== 'object' ||
    !Array.isArray(data.assets)
  ) {
    return null
  }
  return {
    format: 3,
    name: sanitizeString(data.name, 'Untitled Theme', 200),
    author: sanitizeString(data.author, '', 200),
    description: sanitizeString(data.description, '', 5000),
    createdAt: data.createdAt,
    bundleId: sanitizeString(data.bundleId, generateUUID(), 128) || generateUUID(),
    theme: data.theme ?? null,
    globalCSS: sanitizeString(data.globalCSS, '', 2_000_000),
    components: data.components,
    assets: data.assets
      .filter((asset: any) => asset && typeof asset === 'object')
      .map((asset: any) => ({
        slug: sanitizeString(asset.slug),
        originalFilename: sanitizeString(asset.originalFilename, 'asset'),
        mimeType: sanitizeString(asset.mimeType, 'application/octet-stream', 255),
        tags: Array.isArray(asset.tags) ? asset.tags.filter((tag: unknown): tag is string => typeof tag === 'string').slice(0, 32) : [],
        metadata: asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) ? asset.metadata : {},
        archivePath: sanitizeString(asset.archivePath, '', 255),
      }))
      .filter((asset) => !!asset.slug && !!sanitizeArchivePath(asset.archivePath)),
  }
}

function toArchiveManifest(pack: ThemePack): { manifest: ThemePackArchiveManifest; files: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = {}
  const assets: ThemePackArchiveAsset[] = pack.assets.map((asset, index) => {
    const archivePath = `assets/${String(index + 1).padStart(3, '0')}-${sanitizeAssetFileName(asset.originalFilename)}`
    files[archivePath] = base64ToBytes(asset.dataBase64)
    return {
      slug: asset.slug,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      tags: asset.tags,
      metadata: asset.metadata,
      archivePath,
    }
  })
  const manifest: ThemePackArchiveManifest = {
    format: 3,
    name: pack.name,
    author: pack.author,
    description: pack.description,
    createdAt: pack.createdAt,
    bundleId: pack.bundleId,
    theme: pack.theme,
    globalCSS: pack.globalCSS,
    components: pack.components,
    assets,
  }
  files[THEME_JSON] = strToU8(JSON.stringify(manifest, null, 2))
  return { manifest, files }
}

function fromArchiveBytes(bytes: Uint8Array): ThemePackImportResult {
  if (bytes.byteLength > MAX_ARCHIVE_SIZE_BYTES) {
    return importError('invalid-archive-layout', 'Theme archive is too large to import safely.')
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    return importError('invalid-archive-layout', 'Theme archive could not be read as a valid zip bundle.')
  }
  const names = Object.keys(entries)
  if (!names.includes(THEME_JSON)) {
    return importError('missing-theme-json', 'Theme archive is missing theme.json.')
  }
  if (names.length > MAX_ARCHIVE_ENTRIES) {
    return importError('invalid-archive-layout', 'Theme archive contains too many files.')
  }

  let totalBytes = 0
  for (const [name, value] of Object.entries(entries)) {
    if (!sanitizeArchivePath(name)) {
      return importError('invalid-archive-layout', 'Theme archive contains an unsafe file path.')
    }
    if (value.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      return importError('invalid-archive-layout', 'Theme archive contains a file that is too large.')
    }
    totalBytes += value.byteLength
    if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      return importError('invalid-archive-layout', 'Theme archive expands beyond the safe import limit.')
    }
  }

  let rawManifest: any
  try {
    rawManifest = JSON.parse(strFromU8(entries[THEME_JSON]))
  } catch {
    return importError('invalid-archive-layout', 'theme.json is not valid JSON.')
  }
  const manifest = normalizeArchiveManifest(rawManifest)
  if (!manifest) {
    return importError('invalid-archive-layout', 'theme.json is missing required theme bundle fields.')
  }

  const assets: ThemePackAsset[] = []
  for (const asset of manifest.assets) {
    const archivePath = sanitizeArchivePath(asset.archivePath)
    if (!archivePath) {
      return importError('invalid-archive-layout', 'Theme archive contains an invalid asset path.')
    }
    const fileBytes = entries[archivePath]
    if (!fileBytes) {
      return importError('invalid-archive-layout', `Theme archive is missing bundled asset: ${asset.archivePath}`)
    }
    const normalized = sanitizeAsset({
      ...asset,
      dataBase64: bytesToBase64(fileBytes),
    })
    if (!normalized) {
      return importError('invalid-archive-layout', `Theme archive contains an invalid asset entry for ${asset.slug}.`)
    }
    assets.push(normalized)
  }

  return {
    pack: {
      format: 2,
      name: manifest.name,
      author: manifest.author,
      description: manifest.description,
      createdAt: manifest.createdAt,
      bundleId: manifest.bundleId || generateUUID(),
      theme: manifest.theme,
      globalCSS: manifest.globalCSS,
      components: manifest.components,
      assets,
    },
  }
}

/** Snapshot the current theme state into an exportable pack. */
export function createThemePack(
  theme: ThemeConfig | null,
  customCSS: CustomCSSSettings,
  componentOverrides: Record<string, ComponentOverride>,
  assets: ThemePackAsset[],
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
    format: 2,
    name: meta.name || 'Untitled Theme',
    author: meta.author || '',
    description: meta.description || '',
    createdAt: Math.floor(Date.now() / 1000),
    bundleId: customCSS.bundleId || generateUUID(),
    theme,
    globalCSS: customCSS.css || '',
    components,
    assets,
  }
}

function normalizeThemePack(data: any): ThemePack | null {
  if (!data || typeof data !== 'object') return null
  if (data.format === 2) {
    if (
      typeof data.name !== 'string' ||
      typeof data.createdAt !== 'number' ||
      typeof data.bundleId !== 'string' ||
      (data.theme !== null && typeof data.theme !== 'object') ||
      typeof data.globalCSS !== 'string' ||
      typeof data.components !== 'object' ||
      !Array.isArray(data.assets)
    ) {
      return null
    }
    return {
      format: 2,
      name: sanitizeString(data.name, 'Untitled Theme', 200),
      author: sanitizeString(data.author, '', 200),
      description: sanitizeString(data.description, '', 5000),
      createdAt: data.createdAt,
      bundleId: sanitizeString(data.bundleId, generateUUID(), 128) || generateUUID(),
      theme: data.theme ?? null,
      globalCSS: sanitizeString(data.globalCSS, '', 2_000_000),
      components: data.components,
      assets: data.assets
        .map((asset: any) => sanitizeAsset(asset))
        .filter((asset: ThemePackAsset | null): asset is ThemePackAsset => asset !== null),
    }
  }
  if (data.format === 1) {
    const legacy = data as LegacyThemePack
    if (
      typeof legacy.name !== 'string' ||
      typeof legacy.createdAt !== 'number' ||
      (legacy.theme !== null && typeof legacy.theme !== 'object') ||
      typeof legacy.globalCSS !== 'string' ||
      typeof legacy.components !== 'object'
    ) {
      return null
    }
    return {
      format: 2,
      name: sanitizeString(legacy.name, 'Untitled Theme', 200),
      author: sanitizeString(legacy.author, '', 200),
      description: sanitizeString(legacy.description, '', 5000),
      createdAt: legacy.createdAt,
      bundleId: generateUUID(),
      theme: legacy.theme,
      globalCSS: sanitizeString(legacy.globalCSS, '', 2_000_000),
      components: legacy.components,
      assets: [],
    }
  }
  return null
}

/** Validate that a parsed object looks like a theme pack. */
export function validateThemePack(data: any): data is ThemePack {
  return normalizeThemePack(data) !== null
}

/** Download a theme pack as a .lumitheme zip bundle. */
export function exportThemePack(pack: ThemePack): void {
  const { files } = toArchiveManifest(pack)
  const archive = zipSync(files, { level: 6 })
  const archiveCopy = Uint8Array.from(archive)
  const blob = new Blob([archiveCopy], { type: MIME })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pack.name.toLowerCase().replace(/\s+/g, '-') || 'theme'}${EXTENSION}`
  a.click()
  URL.revokeObjectURL(url)
}

function importLegacyThemePack(bytes: Uint8Array): ThemePackImportResult {
  try {
    const text = strFromU8(bytes)
    const data = JSON.parse(text)
    const pack = normalizeThemePack(data)
    return pack
      ? { pack }
      : importError('unsupported-legacy-file', 'Legacy theme file is not a supported Lumiverse theme pack.')
  } catch {
    return importError('unsupported-legacy-file', 'Legacy theme file could not be parsed. Expected a Lumiverse JSON theme pack.')
  }
}

/** Prompt the user to select a theme bundle and parse it. */
export function importThemePack(): Promise<ThemePackImportResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${EXTENSION},${LEGACY_EXTENSION},.json,.zip,application/zip`
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (isZipBytes(bytes) || file.name.toLowerCase().endsWith(EXTENSION) || file.type === 'application/zip') {
          resolve(fromArchiveBytes(bytes))
          return
        }
        resolve(importLegacyThemePack(bytes))
      } catch {
        resolve(importError('unsupported-legacy-file', 'Selected file is not a supported Lumiverse theme bundle.'))
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
  if (pack.assets.length > 0) parts.push(`${pack.assets.length} asset${pack.assets.length !== 1 ? 's' : ''}`)
  return parts
}
