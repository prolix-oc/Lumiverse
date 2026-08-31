import { describe, expect, test } from 'bun:test'
import { formatRawPromptText } from './formatRawPrompt'

describe('formatRawPromptText', () => {
  test('includes per-message reasoning when present', () => {
    const text = formatRawPromptText({
      messages: [
        {
          role: 'assistant',
          content: 'Visible reply',
          reasoning: 'Hidden reasoning',
        },
      ],
    })

    expect(text).toContain('### [1] ASSISTANT')
    expect(text).toContain('Visible reply')
    expect(text).toContain('--- REASONING ---\nHidden reasoning')
  })

  test('omits the reasoning section when the message has none', () => {
    const text = formatRawPromptText({
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
    })

    expect(text).toBe('### [1] USER\n\nHello')
  })

  test('annotates messages that carry non-text content parts', () => {
    const text = formatRawPromptText({
      messages: [
        {
          role: 'user',
          content: 'Hello\n[image: image/png]',
          contentParts: [
            { type: 'image', count: 1 },
            { type: 'audio', count: 1 },
          ],
        },
      ],
    })

    expect(text).toContain('### [1] USER (image x1 | audio x1)')
  })

  test('identifies an exact stored WORK target and its Loom inclusion evidence', () => {
    const text = formatRawPromptText({
      messages: [{ role: 'system', content: 'Exact WORK assembly' }],
      provider: 'Deepseek',
      model: 'deepseek-v4-flash',
      assemblySurface: 'WORK',
      source: 'stored_breakdown',
      target: {
        generationType: 'swipe',
        messageId: 'message-1',
        swipeId: 2,
      },
      loomPromptInspection: {
        version: 1,
        surface: 'WORK',
        checkpoint: 'WORK',
        items: [],
        effectiveEntryIds: [],
      },
    })

    expect(text).toContain('# Deepseek / deepseek-v4-flash')
    expect(text).toContain('Surface: WORK')
    expect(text).toContain('Source: stored_breakdown')
    expect(text).toContain('Generation type: swipe')
    expect(text).toContain('Message ID: message-1')
    expect(text).toContain('Swipe ID: 2')
    expect(text).toContain('### LOOM INCLUSION / OMISSION')
  })
})
