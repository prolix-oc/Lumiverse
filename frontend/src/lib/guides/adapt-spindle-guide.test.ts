import { describe, expect, test } from 'bun:test'
import { adaptSpindleGuide } from './adapt-spindle-guide'

describe('adaptSpindleGuide', () => {
  test('converts Spindle guide metadata into a native markdown guide', () => {
    expect(
      adaptSpindleGuide({
        title: 'Test guide',
        markdown: '# Hello from Spindle',
      }),
    ).toEqual({
      kind: 'markdown',
      title: 'Test guide',
      markdown: '# Hello from Spindle',
    })
  })

  test('returns undefined when no guide is provided', () => {
    expect(adaptSpindleGuide(undefined)).toBeUndefined()
  })
})