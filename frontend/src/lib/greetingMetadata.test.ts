import { describe, expect, test } from 'bun:test'
import {
  getGreetingTitle,
  moveAlternateGreetingMetadata,
  remapGreetingIndexForMove,
  removeAlternateGreetingMetadata,
  setGreetingTitle,
} from './greetingMetadata'

describe('Greeting Tools metadata compatibility', () => {
  test('reads trimmed main and alternate titles through the compatible index map', () => {
    const extensions = {
      greeting_tools: {
        mainGreeting: { id: 'main', title: '  Main route  ' },
        greetings: { second: { id: 'second', title: 'Second route' } },
        indexMap: { 0: 'second' },
      },
    }

    expect(getGreetingTitle(extensions, 0)).toBe('Main route')
    expect(getGreetingTitle(extensions, 1)).toBe('Second route')
    expect(getGreetingTitle(extensions, 2)).toBeNull()
  })

  test('creates stable compatible metadata while preserving unrelated fields', () => {
    const extensions = { unrelated: { keep: true } }
    const next = setGreetingTitle(extensions, 2, 'Rainy café', () => 'g_test')

    expect(next).toEqual({
      unrelated: { keep: true },
      greeting_tools: {
        greetings: { g_test: { id: 'g_test', title: 'Rainy café' } },
        indexMap: { 1: 'g_test' },
      },
    })
    expect(extensions).toEqual({ unrelated: { keep: true } })
  })

  test('updates and clears titles without discarding descriptions, hashes, or unknown data', () => {
    const extensions = {
      greeting_tools: {
        version: 3,
        mainGreeting: { id: 'main', title: 'Old', description: 'Keep main', contentHash: 1 },
        greetings: {
          alt: { id: 'alt', title: 'Old alt', description: 'Keep alt', contentHash: 2, future: true },
        },
        indexMap: { 0: 'alt' },
      },
    }

    const renamed = setGreetingTitle(extensions, 1, '  New alt  ')
    const cleared = setGreetingTitle(renamed, 1, '   ')

    expect(renamed.greeting_tools.greetings.alt).toEqual({
      id: 'alt',
      title: 'New alt',
      description: 'Keep alt',
      contentHash: 2,
      future: true,
    })
    expect(cleared.greeting_tools.greetings.alt).toEqual({
      id: 'alt',
      description: 'Keep alt',
      contentHash: 2,
      future: true,
    })
    expect(cleared.greeting_tools.version).toBe(3)

    const renamedMain = setGreetingTitle(cleared, 0, 'New main')
    expect(renamedMain.greeting_tools.mainGreeting).toEqual({
      id: 'main',
      title: 'New main',
      description: 'Keep main',
      contentHash: 1,
    })
  })

  test('removes one alternate metadata entry and shifts later mappings', () => {
    const extensions = {
      greeting_tools: {
        mainGreeting: { id: 'main', title: 'Main' },
        greetings: {
          a: { id: 'a', title: 'A' },
          b: { id: 'b', title: 'B' },
          c: { id: 'c', title: 'C' },
          orphan: { id: 'orphan', description: 'Preserve unmapped metadata' },
        },
        indexMap: { 0: 'a', 1: 'b', 2: 'c', future: 'value' },
      },
    }

    const next = removeAlternateGreetingMetadata(extensions, 1)

    expect(next.greeting_tools.indexMap).toEqual({ 0: 'a', 1: 'c', future: 'value' })
    expect(next.greeting_tools.greetings).toEqual({
      a: { id: 'a', title: 'A' },
      c: { id: 'c', title: 'C' },
      orphan: { id: 'orphan', description: 'Preserve unmapped metadata' },
    })
    expect(getGreetingTitle(next, 2)).toBe('C')
  })

  test('moves stable alternate metadata IDs and remaps companion greeting indices', () => {
    const extensions = {
      greeting_tools: {
        greetings: {
          a: { id: 'a', title: 'A' },
          b: { id: 'b', title: 'B' },
          c: { id: 'c', title: 'C' },
        },
        indexMap: { 0: 'a', 1: 'b', 2: 'c', future: 'keep' },
      },
    }

    const next = moveAlternateGreetingMetadata(extensions, 0, 2)
    expect(next.greeting_tools.indexMap).toEqual({ 0: 'b', 1: 'c', 2: 'a', future: 'keep' })
    expect(getGreetingTitle(next, 3)).toBe('A')

    expect([1, 2, 3, 4].map((index) => remapGreetingIndexForMove(index, 1, 3)))
      .toEqual([3, 1, 2, 4])
    expect([1, 2, 3, 4].map((index) => remapGreetingIndexForMove(index, 3, 1)))
      .toEqual([2, 3, 1, 4])
  })
})
