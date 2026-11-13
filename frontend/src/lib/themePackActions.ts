import type { TFunction } from 'i18next'
import type { SavedTheme, SettingsSlice } from '@/types/store'
import type { themeAssetsApi } from '@/api/theme-assets'
import type { toast } from '@/lib/toast'
import { createThemePack, exportThemePack, importThemePack, packSummary, type ThemePackAsset } from './themePack'
import { disableImportedThemePackTsx } from './componentOverrideSecurity'
import { generateUUID } from './uuid'

type ThemePackState = Pick<SettingsSlice, 'theme' | 'customCSS' | 'componentOverrides' | 'savedThemes' | 'applyThemePack' | 'addSavedTheme'>

interface ThemePackServices {
  t: TFunction<'modals', 'customCss'>
  themeAssetsApi: Pick<typeof themeAssetsApi, 'list' | 'getBlob' | 'upload'>
  toast: Pick<typeof toast, 'success' | 'error' | 'info'>
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToFile(dataBase64: string, filename: string, mimeType: string): File {
  const binary = atob(dataBase64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new File([bytes], filename, { type: mimeType })
}

function activeSavedThemeName(savedThemes: SavedTheme[], bundleId: string | null): string | null {
  if (!bundleId) return null
  const active = savedThemes.find((entry) => entry.kind === 'pack' && entry.pack.bundleId === bundleId)
  return active?.name.trim() || null
}

/** Shared bundle actions for Settings and the Theme Editor. */
export function createThemePackActions(
  { theme, customCSS, componentOverrides, savedThemes, applyThemePack, addSavedTheme }: ThemePackState,
  { t, themeAssetsApi, toast }: ThemePackServices,
) {
  const buildPackAssets = async (): Promise<ThemePackAsset[]> => {
    const bundleId = customCSS.bundleId
    if (!bundleId) return []
    const assets = await themeAssetsApi.list(bundleId)
    return Promise.all(assets.map(async (asset) => {
      const blob = await themeAssetsApi.getBlob(asset.id)
      return {
        slug: asset.slug,
        originalFilename: asset.original_filename,
        mimeType: asset.mime_type,
        tags: asset.tags,
        metadata: asset.metadata || {},
        dataBase64: await blobToBase64(blob),
      }
    }))
  }

  const handleExportPack = async () => {
    try {
      const assets = await buildPackAssets()
      const pack = createThemePack(theme, customCSS, componentOverrides, assets, {
        name: activeSavedThemeName(savedThemes, customCSS.bundleId) || theme?.name || t('customThemeName'),
      })
      await exportThemePack(pack)
      toast.success(t('exportSuccess'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('exportFailed'))
    }
  }

  const handleImportPack = async () => {
    const result = await importThemePack()
    if (!result) {
      toast.info(t('importCancelled'))
      return
    }
    if (result.error) {
      toast.error(result.error.message)
      return
    }
    const imported = disableImportedThemePackTsx(result.pack)
    const pack = imported.pack
    const localBundleId = generateUUID()
    const localizedPack = {
      ...pack,
      bundleId: localBundleId,
      theme: pack.theme ? { ...pack.theme, name: pack.name } : null,
    }
    try {
      for (const asset of localizedPack.assets) {
        const file = base64ToFile(asset.dataBase64, asset.originalFilename, asset.mimeType)
        await themeAssetsApi.upload(file, {
          bundleId: localBundleId,
          slug: asset.slug,
          tags: asset.tags,
          metadata: asset.metadata,
        })
      }
      const summary = packSummary(localizedPack)
      applyThemePack(localizedPack)
      addSavedTheme({ kind: 'pack', name: pack.name || t('importedThemeName'), pack: localizedPack })
      const disabledNote = imported.disabledCount > 0
        ? t('tsxDisabledNote', { count: imported.disabledCount })
        : ''
      toast.success(t('appliedFromBundle', { name: pack.name, summary: summary.join(', ') }) + disabledNote)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('importFailed'))
    }
  }

  return { handleExportPack, handleImportPack }
}
