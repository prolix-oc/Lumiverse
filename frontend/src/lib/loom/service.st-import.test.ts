import { describe, expect, test } from 'bun:test'
import { computeGroups, importFromSTPreset } from './service'

describe('SillyTavern preset import', () => {
  test('keeps prompts grouped under sequential ━ category headings', () => {
    const preset = importFromSTPreset({
      prompts: [
        { identifier: 'category-one', name: '━━━━ OOC ━━━', content: '' },
        { identifier: 'ooc-tone', name: 'Tone', content: 'Write vividly.' },
        { identifier: 'ooc-style', name: 'Style', content: 'Use prose.' },
        { identifier: 'category-two', name: '━━━━ Optional', content: '' },
        { identifier: 'optional-detail', name: 'Detailing', content: 'Be specific.' },
      ],
      prompt_order: {
        100001: {
          order: [
            { identifier: 'category-one', enabled: true },
            { identifier: 'ooc-tone', enabled: true },
            { identifier: 'ooc-style', enabled: false },
            { identifier: 'category-two', enabled: true },
            { identifier: 'optional-detail', enabled: true },
          ],
        },
      },
    }, 'Celia')

    const categoryOne = preset.blocks.find((block) => block.name === '━━━━ OOC ━━━')!
    const categoryTwo = preset.blocks.find((block) => block.name === '━━━━ Optional')!
    const tone = preset.blocks.find((block) => block.name === 'Tone')!
    const style = preset.blocks.find((block) => block.name === 'Style')!
    const detail = preset.blocks.find((block) => block.name === 'Detailing')!

    expect(categoryOne.marker).toBe('category')
    expect(categoryTwo.marker).toBe('category')
    expect([tone.group, style.group]).toEqual([categoryOne.id, categoryOne.id])
    expect(detail.group).toBe(categoryTwo.id)
    expect(computeGroups(preset.blocks).map((group) => ({
      category: group.categoryBlock?.name,
      children: group.children.map((block) => block.name),
    }))).toEqual(expect.arrayContaining([
      { category: '━━━━ OOC ━━━', children: ['Tone', 'Style'] },
      { category: '━━━━ Optional', children: ['Detailing', 'Chat History'] },
    ]))
  })
})
