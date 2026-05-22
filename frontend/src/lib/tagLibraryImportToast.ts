import type { TagLibraryImportResult } from '@/types/api'

function pluralize(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`
}

export function formatTagLibraryImportToastMessage(result: TagLibraryImportResult): string {
  const lines = [
    `Matched: ${pluralize(result.matchedCharacters, 'character')}`,
    `- Source filename: ${result.matchedBy.source_filename}`,
    `- Avatar filename: ${result.matchedBy.image_original_filename}`,
    `- Name fallback: ${result.matchedBy.normalized_name}`,
    `Unmatched: ${pluralize(result.unmatchedMappings, 'mapping')}`,
  ]

  return lines.join('\n')
}
