import { describe, expect, test } from 'bun:test'
import { replaceHtmlImageSources } from './htmlImageSources'

describe('HTML image source scanning', () => {
  test.each(['gallery', 'asset'] as const)('keeps unmatched text and callback replacements literal in %s mode', (mode) => {
    expect(replaceHtmlImageSources('before <img src="asset"> after', mode, () => '$& $1 $`')).toBe('before $& $1 $` after')
    const unfinished = '<img '.repeat(64) + 'src="asset" '.repeat(64)
    expect(replaceHtmlImageSources(unfinished, mode, () => 'unexpected')).toBe(unfinished)
  })

  test('retains overlapping malformed attributes and exact source boundaries', () => {
    expect(replaceHtmlImageSources('<img src="a src="b">', 'asset', (_match, before, quote, source, after) => JSON.stringify([before, quote, source, after]))).toBe('[" src=\\"a ","\\"","b",""]')
    expect(replaceHtmlImageSources('<img src="a src="b">', 'gallery', (_match, before, quote, source, after) => JSON.stringify([before, quote, source, after]))).toBe('[" ","\\"","a src=","b\\""]')
  })

  test.each(['gallery', 'asset'] as const)('ignores sources outside image tags in %s mode', (mode) => {
    const outside = 'src="outside" '.repeat(128)
    const raw = outside + '<img src="first">' + outside + '<img src="last">' + outside
    const sources: string[] = []
    expect(replaceHtmlImageSources(raw, mode, (match, _before, _quote, source) => {
      sources.push(source)
      return match
    })).toBe(raw)
    expect(sources).toEqual(['first', 'last'])
  })
})
