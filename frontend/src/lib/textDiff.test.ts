import { describe, expect, test } from 'bun:test'
import { computeLineDiff, countDiffLines } from './textDiff'

describe('textDiff', () => {
  test('marks identical text as unchanged', () => {
    const chunks = computeLineDiff('line 1\nline 2', 'line 1\nline 2')
    expect(chunks).toEqual([
      { type: 'unchanged', text: 'line 1' },
      { type: 'unchanged', text: 'line 2' },
    ])
    expect(countDiffLines(chunks)).toEqual({ added: 0, removed: 0 })
  })

  test('computes minimal line diff for middle edits', () => {
    const chunks = computeLineDiff('hello\nold middle\nworld', 'hello\nnew middle\nextra\nworld')
    expect(chunks).toEqual([
      { type: 'unchanged', text: 'hello' },
      { type: 'removed', text: 'old middle' },
      { type: 'added', text: 'new middle' },
      { type: 'added', text: 'extra' },
      { type: 'unchanged', text: 'world' },
    ])
    expect(countDiffLines(chunks)).toEqual({ added: 2, removed: 1 })
  })

  test('handles empty to non-empty and large input fallback', () => {
    expect(countDiffLines(computeLineDiff('', 'a\nb'))).toEqual({ added: 2, removed: 0 })
    expect(countDiffLines(computeLineDiff('a\nb', ''))).toEqual({ added: 0, removed: 2 })

    const bigOld = Array.from({ length: 450 }, (_, i) => `old ${i}`).join('\n')
    const bigNew = Array.from({ length: 450 }, (_, i) => `new ${i}`).join('\n')
    const bigChunks = computeLineDiff(bigOld, bigNew)
    expect(countDiffLines(bigChunks)).toEqual({ added: 450, removed: 450 })
  })
})
