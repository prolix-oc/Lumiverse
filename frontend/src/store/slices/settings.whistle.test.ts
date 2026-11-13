import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { createSettingsSlice, resetSettingsPersistence } from './settings'

function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) =>
    Object.assign(state, typeof value === 'function' ? value(state) : value)
  Object.assign(state, createSettingsSlice(set as never, () => state, {} as never))
  return state
}
afterEach(resetSettingsPersistence)

describe('Whistle voice preferences', () => {
  test('selects automatic detection when the previous provider language is unsupported', () => {
    const app = store()
    app.voiceSettings.sttLanguage = 'ja-JP'
    app.voiceSettings.sttConnectionId = 'remote'
    app.setVoiceSettings({ sttProvider: 'whistle' })
    expect(app.voiceSettings.sttLanguage).toBe('auto')
    expect(app.voiceSettings.sttConnectionId).toBeNull()
    expect(app.voiceSettings.sttProvider).toBe('whistle')
  })

  test('preserves supported language choices across providers', () => {
    const app = store()
    app.voiceSettings.sttLanguage = 'fr-FR'
    app.setVoiceSettings({ sttProvider: 'whistle' })
    expect(app.voiceSettings.sttLanguage).toBe('fr')
    app.setVoiceSettings({ sttProvider: 'webspeech' })
    expect(app.voiceSettings.sttLanguage).toBe('fr-FR')
  })

  test('returns to a valid browser locale from automatic language detection', () => {
    const app = store()
    app.setVoiceSettings({ sttProvider: 'whistle', sttLanguage: 'auto' })
    app.setVoiceSettings({ sttProvider: 'connection' })
    expect(app.voiceSettings.sttLanguage).toBe('en-US')
  })
})
