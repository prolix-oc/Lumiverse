import { describe, expect, test } from 'bun:test'

function readCssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing CSS block: ${marker}`)

  const openingBrace = source.indexOf('{', markerIndex)
  if (openingBrace < 0) throw new Error(`Missing opening brace for: ${marker}`)

  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBrace + 1, index)
  }

  throw new Error(`Missing closing brace for: ${marker}`)
}

describe('MessageEditArea mobile actions', () => {
  test('keeps the sticky action row transparent', async () => {
    const css = await Bun.file(new URL('./MessageEditArea.module.css', import.meta.url)).text()
    const mobileCss = readCssBlock(css, '@media (max-width: 600px)')
    const editActions = readCssBlock(mobileCss, '.editActions {')

    expect(editActions).toMatch(/position:\s*sticky/)
    expect(editActions).toMatch(/background:\s*transparent/)
    expect(editActions).not.toContain('--lumiverse-surface')
  })
})
