import { describe, expect, it } from 'bun:test'

import { importRegexFiles } from './regexImportBatch'

describe('importRegexFiles', () => {
  it('imports every selected JSON and aggregates the results', async () => {
    const payloads: unknown[] = []
    const files = [
      new File(['[{"name":"First"}]'], 'first.json'),
      new File(['{"scripts":[{"name":"Second"}]}'], 'second.json'),
    ]

    const result = await importRegexFiles(files, async (payload) => {
      payloads.push(payload)
      return payloads.length === 1
        ? { imported: 1, skipped: 0, errors: [] }
        : { imported: 2, skipped: 1, errors: ['Script 2: invalid script'] }
    }, { invalidJson: 'Invalid JSON file', importFailed: 'Import failed' })

    expect(payloads).toEqual([
      [{ name: 'First' }],
      { scripts: [{ name: 'Second' }] },
    ])
    expect(result).toEqual({
      imported: 3,
      skipped: 1,
      errors: ['second.json: Script 2: invalid script'],
    })
  })

  it('continues after invalid JSON and a failed file import', async () => {
    const files = [
      new File(['not-json'], 'invalid.json'),
      new File(['[]'], 'failed.json'),
      new File(['[]'], 'valid.json'),
    ]
    let importCalls = 0

    const result = await importRegexFiles(files, async () => {
      importCalls++
      if (importCalls === 1) throw { body: { error: 'Request rejected' } }
      return { imported: 1, skipped: 0, errors: [] }
    }, { invalidJson: 'Invalid JSON file', importFailed: 'Import failed' })

    expect(importCalls).toBe(2)
    expect(result).toEqual({
      imported: 1,
      skipped: 0,
      errors: [
        'invalid.json: Invalid JSON file',
        'failed.json: Request rejected',
      ],
    })
  })
})
