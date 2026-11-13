import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearWindowFileImports,
  detectWindowFileImportKind,
  queueWindowFileImport,
  subscribeWindowFileImport,
  supportedWindowImportFiles,
} from './window-file-import'

afterEach(clearWindowFileImports)

describe('window file imports', () => {
  test('recognizes supported browser files and ignores other drops', () => {
    const card = new File(['card'], 'Alice.PNG')
    const book = new File(['{}'], 'lorebook.json')
    expect(supportedWindowImportFiles([card, new File(['notes'], 'notes.txt'), book])).toEqual([card, book])
  })

  test('routes recognizable character, preset, and world book formats without an open tab', async () => {
    expect(await detectWindowFileImportKind([new File(['image'], 'card.charx')])).toBe('character')
    expect(await detectWindowFileImportKind([new File(['{"spec":"chara_card_v3"}'], 'card.json')])).toBe('character')
    expect(await detectWindowFileImportKind([new File(['{"blocks":[]}'], 'preset.json')])).toBe('preset')
    expect(await detectWindowFileImportKind([new File(['{"prompts":[]}'], 'legacy.json')])).toBe('preset')
    expect(await detectWindowFileImportKind([new File(['{"type":"lumiverse_world_book","entries":[]}'], 'book.json')])).toBe('worldbook')
    expect(await detectWindowFileImportKind([new File(['{"entries":{}}'], 'legacy-book.json')])).toBe('worldbook')
    expect(await detectWindowFileImportKind([new File(['{}'], 'unknown.json')])).toBeNull()
    expect(await detectWindowFileImportKind([
      new File(['image'], 'card.png'), new File(['{"blocks":[]}'], 'preset.json'),
    ])).toBeNull()
  })

  test('retains files until their importer mounts and delivers each drop only once', async () => {
    const card = new File(['image'], 'card.png')
    const received: File[][] = []
    queueWindowFileImport('character', [card])
    const unsubscribe = subscribeWindowFileImport('character', async (files) => {
      received.push(files)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([[card]])
    unsubscribe()
    const unsubscribeAgain = subscribeWindowFileImport('character', (files) => { received.push(files) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([[card]])
    unsubscribeAgain()
  })

  test('processes successive drops in order while an importer is busy', async () => {
    const first = new File(['{}'], 'first.json')
    const second = new File(['{}'], 'second.json')
    const received: string[] = []
    let finishFirst: (() => void) | undefined
    const firstImport = new Promise<void>((resolve) => { finishFirst = resolve })
    const unsubscribe = subscribeWindowFileImport('preset', async (files) => {
      received.push(files[0].name)
      if (files[0] === first) await firstImport
    })

    queueWindowFileImport('preset', [first])
    queueWindowFileImport('preset', [second])
    expect(received).toEqual(['first.json'])
    finishFirst?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual(['first.json', 'second.json'])
    unsubscribe()
  })
})
