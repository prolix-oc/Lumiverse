export interface PresetImportBatchResult {
  imported: number
  skipped: number
  errors: string[]
}

type ImportPresetPayload = (payload: unknown, filename: string) => Promise<unknown | null>

function getImportErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback

  const body = 'body' in error ? error.body : undefined
  if (body && typeof body === 'object') {
    if ('error' in body && typeof body.error === 'string') return body.error
    if ('message' in body && typeof body.message === 'string') return body.message
  }
  if ('message' in error && typeof error.message === 'string') return error.message
  return fallback
}

/**
 * Parse and import every selected preset in order. Processing files one at a
 * time keeps preset selection and embedded-regex ownership deterministic, and
 * a malformed file cannot prevent the remaining files from being imported.
 */
export async function importPresetFiles(
  files: readonly File[],
  importPayload: ImportPresetPayload,
  messages: { invalidJson: string; importFailed: string },
): Promise<PresetImportBatchResult> {
  const result: PresetImportBatchResult = { imported: 0, skipped: 0, errors: [] }

  for (const file of files) {
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch {
      result.errors.push(`${file.name}: ${messages.invalidJson}`)
      continue
    }

    try {
      const imported = await importPayload(payload, file.name)
      if (imported !== null) result.imported += 1
      else result.skipped += 1
    } catch (error) {
      result.errors.push(`${file.name}: ${getImportErrorMessage(error, messages.importFailed)}`)
    }
  }

  return result
}
