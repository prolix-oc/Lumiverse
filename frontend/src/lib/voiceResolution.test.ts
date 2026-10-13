import { describe, expect, test } from 'bun:test'
import type { VoiceSettings } from '@/types/store'
import {
  resolveMessageVoices,
  resolveSegmentVoice,
  type ResolveVoiceInput,
} from './voiceResolution'

function voiceSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    sttProvider: 'webspeech', sttLanguage: 'en-US', sttContinuous: false,
    sttInterimResults: true, sttAutoSubmitOnSilence: false, sttShowMicButton: true,
    sttConnectionId: null, ttsEnabled: true, ttsConnectionId: null,
    ttsAutoPlay: false, ttsSpeed: 1, ttsVolume: 1,
    speechDetectionRules: { asterisked: 'thought', quoted: 'speech', undecorated: 'narration' },
    narrationVoice: null,
    ...overrides,
  }
}

function input(overrides: Partial<ResolveVoiceInput> = {}): ResolveVoiceInput {
  return {
    segment: { action: 'speech' },
    speaker: { characterId: 'alice', isUser: false },
    character: { extensions: {} }, chatMetadata: null,
    voiceSettings: voiceSettings(),
    ttsProfiles: [{ id: 'other', is_default: false }, { id: 'default', is_default: true }],
    ...overrides,
  }
}

describe('message voice fallbacks', () => {
  test.each(['speech', 'narration', 'thought'] as const)('%s uses the default connection without overrides', (action) => {
    expect(resolveSegmentVoice(input({ segment: { action } }))).toEqual({
      action, voice: { connectionId: 'default', voice: '' },
    })
  })

  test('does not choose an arbitrary connection when none is marked default', () => {
    expect(resolveSegmentVoice(input({ ttsProfiles: [{ id: 'other', is_default: false }] })).voice).toBeNull()
  })

  test('an explicit global selection takes precedence over the default connection', () => {
    expect(resolveSegmentVoice(input({ voiceSettings: voiceSettings({ ttsConnectionId: 'selected' }) })).voice)
      .toEqual({ connectionId: 'selected', voice: '' })
  })

  test('character voices take precedence over the global selection and also cover narration', () => {
    const character = { extensions: { ttsVoice: { connectionId: 'character', voice: 'Kore' } } }
    for (const action of ['speech', 'narration', 'thought'] as const) {
      expect(resolveSegmentVoice(input({ character, segment: { action } })).voice)
        .toEqual({ connectionId: 'character', voice: 'Kore', parameters: undefined })
    }
  })

  test('chat narrator and character overrides keep their separate voices and speeds', () => {
    const speech = { connectionId: 'chat-speech', voice: 'Puck', parameters: { speed: 0.8 } }
    const narration = { connectionId: 'chat-narrator', voice: 'Kore', parameters: { speed: 1.2 } }
    const chatMetadata = { voiceOverrides: { characters: { alice: speech }, narrator: narration } }
    expect(resolveSegmentVoice(input({ chatMetadata })).voice).toEqual(speech)
    expect(resolveSegmentVoice(input({ chatMetadata, segment: { action: 'narration' } })).voice).toEqual(narration)
  })

  test('an incomplete narrator selection falls back to the speech voice', () => {
    expect(resolveSegmentVoice(input({
      segment: { action: 'narration' },
      voiceSettings: voiceSettings({ narrationVoice: { connectionId: '', voice: '' } }),
    })).voice).toEqual({ connectionId: 'default', voice: '' })
  })

  test('a narrator connection with no voice override inherits its saved voice', () => {
    expect(resolveSegmentVoice(input({
      segment: { action: 'narration' },
      voiceSettings: voiceSettings({ narrationVoice: { connectionId: 'narrator', voice: '' } }),
    })).voice).toEqual({ connectionId: 'narrator', voice: '', parameters: undefined })
  })

  test('skip rules still suppress synthesis', () => {
    expect(resolveSegmentVoice(input({ segment: { action: 'skip' } }))).toEqual({ action: 'skip', voice: null })
  })

  test('group member matching keeps another character with the same name from taking the voice', () => {
    const context = {
      characters: [
        { id: 'outsider', name: 'Alice', extensions: { ttsVoice: { connectionId: 'wrong', voice: '' } } },
        { id: 'alice', name: 'Alice', extensions: { ttsVoice: { connectionId: 'member', voice: '' } } },
      ],
      groupMemberIds: ['alice'], fallbackCharacterId: null, chatMetadata: null,
      voiceSettings: voiceSettings(), ttsProfiles: [{ id: 'default', is_default: true }],
    }
    expect(resolveMessageVoices({ ...context, message: { name: 'ALICE', is_user: false } }).speech?.connectionId)
      .toBe('member')
    expect(resolveMessageVoices({ ...context, message: { name: 'Alice', is_user: true } }).speech?.connectionId)
      .toBe('default')
  })
})
