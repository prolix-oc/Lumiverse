import { describe, expect, test } from 'bun:test'
import { worldBookPayloadFromFile } from './world-book-file-import'

describe('world book file imports', () => {
  test('preserves a named export', async () => {
    const payload = await worldBookPayloadFromFile(new File([
      '{"name":"Lore","description":"Imported","entries":[]}',
    ], 'lore.json'))
    expect(payload.name).toBe('Lore')
    expect(payload.description).toBe('Imported')
    expect(payload.entries).toEqual([])
  })

  test('uses the filename for an unnamed import', async () => {
    const payload = await worldBookPayloadFromFile(new File(['{"entries":{}}'], 'my-book.json'))
    expect(payload.originalName).toBe('my-book')
    expect(payload.description).toStartWith('Uploaded at ')
  })
})
