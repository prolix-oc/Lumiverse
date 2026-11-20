export interface RegexImportResult {
  imported: number
  skipped: number
  errors: string[]
}

type ImportPayload = (payload: unknown) => Promise<RegexImportResult>

function getImportErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback

  const body = 'body' in error ? error.body : undefined
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error
  }
  if ('message' in error && typeof error.message === 'string') return error.message
  return fallback
}

/**
 * Parse and import every selected file in a deterministic order. Files are
 * submitted separately so top-level import options (such as folders) remain
 * scoped to the JSON file that declared them.
 */
export async function importRegexFiles(
  files: readonly File[],
  importPayload: ImportPayload,
  messages: { invalidJson: string; importFailed: string },
): Promise<RegexImportResult> {
  const batchResult: RegexImportResult = { imported: 0, skipped: 0, errors: [] }

  for (const file of files) {
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch {
      batchResult.errors.push(`${file.name}: ${messages.invalidJson}`)
      continue
    }

    try {
      const result = await importPayload(payload)
      batchResult.imported += result.imported
      batchResult.skipped += result.skipped
      batchResult.errors.push(...result.errors.map((error) => `${file.name}: ${error}`))
    } catch (error) {
      batchResult.errors.push(`${file.name}: ${getImportErrorMessage(error, messages.importFailed)}`)
    }
  }

  return batchResult
}
