import { expect, mock, test } from 'bun:test'
import { invalidateSharedReads } from '@/lib/shared-read'
const get = mock(async (_path: string, _params?: unknown) => ({ defaults: null, chat: null, persona: null, character: null, connection: null }))
mock.module('./client', () => ({ get, put: async () => {}, del: async () => {}, patch: async () => {} }))
const { presetProfilesApi } = await import('./preset-profiles')

test('five binding consumers share one context request, with new reads for edits and context changes', async () => {
  const context = { preset_id: 'p', chat_id: 'chat', persona_id: 'persona', character_id: 'character', connection_id: 'connection', is_group: false, revision: 0 }
  await Promise.all(Array.from({ length: 5 }, () => presetProfilesApi.context(context)))
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0]).toEqual(['/preset-profiles/context', context])
  invalidateSharedReads()
  await Promise.all([presetProfilesApi.context(context), presetProfilesApi.context({ ...context, chat_id: 'other' })])
  expect(get).toHaveBeenCalledTimes(3)
})
