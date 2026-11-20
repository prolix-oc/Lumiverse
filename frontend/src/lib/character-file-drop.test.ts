import { describe, expect, test } from 'bun:test'
import { characterFilesFromDrop } from './character-file-drop'

describe('character file drops', () => {
  test('keeps supported browser files in drop order without re-reading their paths', () => {
    const json = new File(['{}'], 'Alice.JSON', { type: 'application/json' })
    const ignored = new File(['notes'], 'notes.txt')
    const png = new File([new Uint8Array([1, 2, 3])], 'Bob.png', { type: 'image/png' })
    const charx = new File(['archive'], 'Charlie.charx')
    const jpg = new File(['image'], 'Avatar.JPEG')

    expect(characterFilesFromDrop([json, ignored, png, charx, jpg])).toEqual([
      json, png, charx, jpg,
    ])
  })

  test('ignores drops without supported files', () => {
    expect(characterFilesFromDrop([new File(['nope'], 'notes.txt')])).toEqual([])
  })
})
