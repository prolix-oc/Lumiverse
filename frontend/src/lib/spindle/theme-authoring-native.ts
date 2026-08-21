import { themeAssetsApi } from '@/api/theme-assets'
import { useStore } from '@/store'
import { CSS_MODULE_REGISTRY } from '@/lib/cssModuleRegistry'
import GENERATED_VARS from '@/lib/generatedCssVariables'
import { generateUUID } from '@/lib/uuid'
import {
  createThemeAuthoringAPI,
  type SpindleThemeAuthoringAPI,
} from './theme-authoring'

/** Bind the public authoring façade to Lumiverse's existing native services. */
export function createNativeThemeAuthoringAPI(
  assertActive: () => void,
  requireAppManipulation: (member: string) => void,
): SpindleThemeAuthoringAPI {
  return createThemeAuthoringAPI({
    assertActive,
    requireAppManipulation,
    assetClient: themeAssetsApi,
    getStore: () => useStore.getState(),
    createBundleId: generateUUID,
    componentCatalog: CSS_MODULE_REGISTRY,
    variableCatalog: GENERATED_VARS,
    computedValue: (name) => {
      if (typeof document === 'undefined') return undefined
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined
    },
  })
}
