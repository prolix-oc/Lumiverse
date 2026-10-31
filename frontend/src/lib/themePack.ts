import { encodeThemePackArchive, decodeThemePackArchive, type ThemePack, type ThemePackImportResult } from '../../../src/utils/theme-pack'
export * from '../../../src/utils/theme-pack'
const EXTENSION = '.lumitheme'
const LEGACY_EXTENSION = '.lumiverse-theme'
const MIME = 'application/zip'
/** Download a theme pack as a .lumitheme zip bundle. */
export function exportThemePack(pack: ThemePack): void {
  const archiveCopy = encodeThemePackArchive(pack)
  const blobBytes = new Uint8Array(archiveCopy.byteLength)
  blobBytes.set(archiveCopy)
  const blob = new Blob([blobBytes.buffer], { type: MIME })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pack.name.toLowerCase().replace(/\s+/g, '-') || 'theme'}${EXTENSION}`
  a.click()
  URL.revokeObjectURL(url)
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
        resolve(decodeThemePackArchive(bytes))
      } catch {
        resolve({ error: { code: 'unsupported-legacy-file', message: 'Selected file is not a supported Lumiverse theme bundle.' } })
      } finally {
        input.value = ''
      }
    }
    // If user cancels the file picker
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export function packSummary(pack: ThemePack): string[] {
  const parts: string[] = []
  if (pack.theme) parts.push('Theme colors & settings')
  if (pack.globalCSS.trim()) parts.push('Global CSS overrides')
  const compCount = Object.keys(pack.components).length
  if (compCount > 0) parts.push(`${compCount} component override${compCount !== 1 ? 's' : ''}`)
  if (pack.assets.length > 0) parts.push(`${pack.assets.length} asset${pack.assets.length !== 1 ? 's' : ''}`)
  return parts
}
