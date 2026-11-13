import { describe, expect, test } from 'bun:test'
import {
  areReasoningSettingsEqual,
  captureReasoningBindings,
  getEffortOptions,
  normalizeReasoningSettingsForProvider,
} from './reasoning-binding'
import type { ReasoningSettings } from '@/types/store'

const currentSettings: ReasoningSettings = {
  prefix: '<think>\n',
  suffix: '\n</think>',
  autoParse: true,
  apiReasoning: true,
  reasoningEffort: 'medium',
  keepInHistory: -1,
  thinkingDisplay: 'auto',
  clearThinking: false,
  replayThoughtSignatures: true,
  customBody: { enabled: true, rawJson: '{"temperature":0.7}' },
}

describe('captureReasoningBindings', () => {
  test('captures every current reasoning option and normalizes it for the bound connection', () => {
    const captured = captureReasoningBindings(currentSettings, 'Continue directly.', 'zai', 'glm-5.3')

    expect(captured).toEqual({
      settings: {
        ...currentSettings,
        // GLM 5.3 exposes low, high, and max — medium maps to the nearest tier.
        reasoningEffort: 'high',
      },
      promptBias: 'Continue directly.',
    })
    expect(captured.settings).not.toBe(currentSettings)
    expect(
      areReasoningSettingsEqual(
        captured.settings,
        normalizeReasoningSettingsForProvider(currentSettings, 'zai', 'glm-5.3'),
      ),
    ).toBe(true)
  })

  test('treats null values from older snapshots as unset instead of dirty changes', () => {
    const legacySnapshot = {
      ...currentSettings,
      clearThinking: null,
      replayThoughtSignatures: null,
    } as unknown as ReasoningSettings
    const expectedCurrentSettings = { ...currentSettings }
    delete expectedCurrentSettings.clearThinking
    delete expectedCurrentSettings.replayThoughtSignatures

    expect(
      normalizeReasoningSettingsForProvider(legacySnapshot, 'google', 'gemini-2.5-pro'),
    ).toEqual(expectedCurrentSettings)
    expect(areReasoningSettingsEqual(legacySnapshot, expectedCurrentSettings)).toBe(true)
  })

  test('exposes GLM 5.3 reasoning efforts for GLM 5.3 Flash', () => {
    expect(getEffortOptions('zai', 'glm-5.3-flash').map(({ value }) => value)).toEqual([
      'auto',
      'low',
      'high',
      'max',
    ])
  })
})

describe('getEffortOptions', () => {
  test('exposes XHigh for Opus 4.7 and version-matched Opus 4.8+ models', () => {
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5']) {
      expect(getEffortOptions('anthropic', model).map(({ value }) => value)).toContain('xhigh')
    }
  })

  test('does not expose XHigh for older Opus or other Claude families', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-5-5']) {
      expect(getEffortOptions('anthropic', model).map(({ value }) => value)).not.toContain('xhigh')
    }
  })
})
