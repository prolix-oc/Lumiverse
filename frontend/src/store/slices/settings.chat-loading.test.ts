import { afterEach, expect, test } from 'bun:test'
import { resetSettingsPersistence, shouldReloadSettingsAfterUpdate } from './settings'

afterEach(resetSettingsPersistence)

test('navigation bookmarks skip full settings hydration while account updates still reload', () => {
  expect(shouldReloadSettingsAfterUpdate({ key: 'activeChatId', value: 'chat' })).toBe(false)
  expect(shouldReloadSettingsAfterUpdate({ keys: ['activeChatId'] })).toBe(false)
  expect(shouldReloadSettingsAfterUpdate({ key: 'activePersonaId', value: 'persona' })).toBe(true)
  expect(shouldReloadSettingsAfterUpdate({ keys: ['activeChatId', 'activePersonaId'] })).toBe(true)
  expect(shouldReloadSettingsAfterUpdate({})).toBe(true)
})
