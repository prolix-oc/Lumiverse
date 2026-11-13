import type { TFunction } from 'i18next'
import type { TagLibraryImportResult } from '@/types/api'

export function formatTagLibraryImportToastMessage(
  t: TFunction<'settings'>,
  result: TagLibraryImportResult,
): string {
  return [
    t('migration.tagLibraryToastMatched', { count: result.matchedCharacters }),
    t('migration.tagLibraryToastBySource', { count: result.matchedBy.source_filename }),
    t('migration.tagLibraryToastByAvatar', { count: result.matchedBy.image_original_filename }),
    t('migration.tagLibraryToastByName', { count: result.matchedBy.normalized_name }),
    t('migration.tagLibraryToastUnmatched', { count: result.unmatchedMappings }),
  ].join('\n')
}
