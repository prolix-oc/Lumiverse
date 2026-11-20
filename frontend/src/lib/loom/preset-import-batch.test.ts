import { describe, expect, test } from 'bun:test'

import { importPresetFiles } from './preset-import-batch'

describe('importPresetFiles', () => {
  test('imports every selected preset sequentially and tracks format skips', async () => {
    const files = [
      new File(['{"name":"First"}'], 'first.json'),
      new File(['{"name":"Wrong format"}'], 'wrong-format.json'),
      new File(['{"name":"Last"}'], 'last.json'),
    ]
    const importedNames: string[] = []
    let activeImport = false

    const result = await importPresetFiles(files, async (payload, filename) => {
      expect(activeImport).toBe(false)
      activeImport = true
      await Promise.resolve()
      activeImport = false
      importedNames.push(`${filename}:${(payload as { name: string }).name}`)
      return filename === 'wrong-format.json' ? null : { name: filename }
    }, { invalidJson: 'Invalid preset JSON', importFailed: 'Preset import failed' })

    expect(importedNames).toEqual([
      'first.json:First',
      'wrong-format.json:Wrong format',
      'last.json:Last',
    ])
    expect(result).toEqual({ imported: 2, skipped: 1, errors: [] })
  })

  test('continues after invalid JSON and a rejected preset', async () => {
    const files = [
      new File(['not-json'], 'invalid.json'),
      new File(['{}'], 'rejected.json'),
      new File(['{}'], 'valid.json'),
    ]
    const importedFiles: string[] = []

    const result = await importPresetFiles(files, async (_payload, filename) => {
      importedFiles.push(filename)
      if (filename === 'rejected.json') throw { body: { error: 'Unsupported preset' } }
      return { name: 'Valid' }
    }, { invalidJson: 'Invalid preset JSON', importFailed: 'Preset import failed' })

    expect(importedFiles).toEqual(['rejected.json', 'valid.json'])
    expect(result).toEqual({
      imported: 1,
      skipped: 0,
      errors: [
        'invalid.json: Invalid preset JSON',
        'rejected.json: Unsupported preset',
      ],
    })
  })
})
