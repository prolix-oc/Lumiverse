import { describe, expect, test } from 'bun:test'
import { supportsClaudeOpusXhigh } from './claude-model'

describe('supportsClaudeOpusXhigh', () => {
  test('keeps Opus 4.7 eligible and enables every Opus 4.8+ version', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4.8',
      'claude-opus-4-8-20260604',
      'claude-opus-5',
      'claude-opus-5-5',
      'anthropic/claude-opus-5.5',
      'claude-opus-6',
    ]) {
      expect(supportsClaudeOpusXhigh(model)).toBe(true)
    }
  })

  test('rejects older Opus versions, dated 4.0 aliases, and other families', () => {
    for (const model of [
      'claude-opus-4-6',
      'claude-opus-4-20250514',
      'claude-sonnet-5-5',
      'not-claude-opus-5-5',
    ]) {
      expect(supportsClaudeOpusXhigh(model)).toBe(false)
    }
  })
})
