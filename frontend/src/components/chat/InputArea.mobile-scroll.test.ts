/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, 'InputArea.module.css'), 'utf8')

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

describe('mobile input action bar scrolling contract', () => {
  const mobileCss = readCssBlock(css, '@media (max-width: 600px)')

  test('uses native horizontal scrolling without wrapping', () => {
    const actionBar = readCssBlock(mobileCss, '.actionBar {')

    expect(actionBar).toMatch(/flex-wrap:\s*nowrap/)
    expect(actionBar).toMatch(/overflow-x:\s*auto/)
    expect(actionBar).toMatch(/overflow-y:\s*hidden/)
    expect(actionBar).toMatch(/-webkit-overflow-scrolling:\s*touch/)
  })

  test('keeps native and extension actions from shrinking', () => {
    const actionButton = readCssBlock(mobileCss, '.actionBtn {')
    const extensionActions = readCssBlock(
      mobileCss,
      ".actionBar :global([data-spindle-mount='chat_actions'] > *) {",
    )

    expect(actionButton).toMatch(/width:\s*28px/)
    expect(actionButton).toMatch(/flex:\s*0\s+0\s+28px/)
    expect(extensionActions).toMatch(/flex-shrink:\s*0/)
  })

  test('hides the scrollbar while preserving the scroll container', () => {
    const actionBar = readCssBlock(mobileCss, '.actionBar {')
    const webkitScrollbar = readCssBlock(mobileCss, '.actionBar::-webkit-scrollbar {')

    expect(actionBar).toMatch(/scrollbar-width:\s*none/)
    expect(webkitScrollbar).toMatch(/display:\s*none/)
  })
})
