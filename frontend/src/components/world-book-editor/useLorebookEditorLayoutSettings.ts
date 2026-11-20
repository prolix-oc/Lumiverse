import { useStore } from '@/store'
import type { SurfaceRectPrefs } from '@/types/store'

export interface LorebookEditorLayoutSettings {
  defaultVariant: 'full' | 'half'
  triggerDisplay: 'words' | 'icons'
  halfButtonEnabled: boolean
  loreIndicatorActionEnabled: boolean
  allowSimultaneousEditors: boolean
  halfEditorMode: 'docked' | 'floating'
  fullRect: SurfaceRectPrefs
  halfRect: SurfaceRectPrefs
  minChatWidth: number
  minEditorPaneWidth: number
  halfEntriesPaneWidth: number
  booksPaneWidth: number
  entriesPaneWidth: number
  inspectorPaneWidth: number
  rowDensity: 'compact' | 'balanced' | 'spacious'
  visibleEntryMetadata: string[]
  entryMetadataVersion?: number
}

export function getLorebookEditorLayoutSettings(): LorebookEditorLayoutSettings {
  return useStore.getState().lorebookEditorSettings as unknown as LorebookEditorLayoutSettings
}

export function updateLorebookEditorLayoutSettings(patch: Partial<LorebookEditorLayoutSettings>): void {
  const current = useStore.getState().lorebookEditorSettings
  useStore.getState().setSetting('lorebookEditorSettings', {
    ...current,
    ...patch,
    ...(patch.fullRect ? { fullRect: { ...patch.fullRect } } : {}),
    ...(patch.halfRect ? { halfRect: { ...patch.halfRect } } : {}),
    ...(patch.visibleEntryMetadata ? { visibleEntryMetadata: [...patch.visibleEntryMetadata] } : {}),
  } as typeof current)
}

export function useLorebookEditorLayoutSettings() {
  const settings = useStore((state) => state.lorebookEditorSettings as unknown as LorebookEditorLayoutSettings)
  return { settings, updateSettings: updateLorebookEditorLayoutSettings }
}
