/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test'
import type { ConnectionProfile } from '@/types/api'

// The hook module pulls in the store (→ i18n → import.meta.glob), which is
// vite-only. Mock the store so the pure core is importable under bun test.
mock.module('@/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}))

const { resolveEffectiveChatConnection } = await import('@/hooks/useEffectiveChatConnection')

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: `Profile ${id}`,
    provider: 'openai',
    api_url: 'https://api.openai.com/v1',
    model: 'gpt-test',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

function resolve(overrides: Partial<Parameters<typeof resolveEffectiveChatConnection>[0]> = {}) {
  return resolveEffectiveChatConnection({
    profiles: [profile('pinned'), profile('charbound'), profile('active')],
    activeProfileId: 'active',
    activeChatMetadata: null,
    activeCharacterConnectionId: null,
    ...overrides,
  })
}

describe('resolveEffectiveChatConnection', () => {
  test('without bindings the active profile wins and no override is reported', () => {
    const result = resolve()
    expect(result.effectiveConnectionId).toBe('active')
    expect(result.overrideSource).toBeNull()
    expect(result.chatPinnedConnectionId).toBeNull()
    expect(result.characterBoundConnectionId).toBeNull()
    expect(result.profile?.id).toBe('active')
    expect(result.profile?.name).toBe('Profile active')
  })

  test('chat pin beats character bind beats active profile', () => {
    const both = resolve({
      activeChatMetadata: { connection_profile_id: 'pinned' },
      activeCharacterConnectionId: 'charbound',
    })
    expect(both.effectiveConnectionId).toBe('pinned')
    expect(both.overrideSource).toBe('chat')

    const charOnly = resolve({ activeCharacterConnectionId: 'charbound' })
    expect(charOnly.effectiveConnectionId).toBe('charbound')
    expect(charOnly.overrideSource).toBe('character')

    const pinOnly = resolve({ activeChatMetadata: { connection_profile_id: 'pinned' } })
    expect(pinOnly.effectiveConnectionId).toBe('pinned')
    expect(pinOnly.overrideSource).toBe('chat')
  })

  test('group chats skip the character bind entirely (chat pin still applies)', () => {
    const result = resolve({
      activeChatMetadata: { group: true },
      activeCharacterConnectionId: 'charbound',
    })
    expect(result.effectiveConnectionId).toBe('active')
    expect(result.overrideSource).toBeNull()
    expect(result.characterBoundConnectionId).toBeNull()

    const withPin = resolve({
      activeChatMetadata: { group: true, connection_profile_id: 'pinned' },
      activeCharacterConnectionId: 'charbound',
    })
    expect(withPin.effectiveConnectionId).toBe('pinned')
    expect(withPin.overrideSource).toBe('chat')
  })

  test('binds naming connections missing from the loaded profiles degrade to the next rung', () => {
    const danglingPin = resolve({
      activeChatMetadata: { connection_profile_id: 'deleted-elsewhere' },
      activeCharacterConnectionId: 'charbound',
    })
    // The dangling pin is skipped; the character bind is the next rung.
    expect(danglingPin.effectiveConnectionId).toBe('charbound')
    expect(danglingPin.overrideSource).toBe('character')
    expect(danglingPin.chatPinnedConnectionId).toBeNull()

    const danglingBoth = resolve({
      activeChatMetadata: { connection_profile_id: 'deleted-elsewhere' },
      activeCharacterConnectionId: 'also-deleted',
    })
    expect(danglingBoth.effectiveConnectionId).toBe('active')
    expect(danglingBoth.overrideSource).toBeNull()
    expect(danglingBoth.characterBoundConnectionId).toBeNull()
  })

  test('non-string metadata pins and absent active profile degrade gracefully', () => {
    const nonString = resolve({ activeChatMetadata: { connection_profile_id: 42 } })
    expect(nonString.chatPinnedConnectionId).toBeNull()

    const noActive = resolve({ activeProfileId: null, activeChatMetadata: { connection_profile_id: 'pinned' } })
    expect(noActive.effectiveConnectionId).toBe('pinned')

    const nothing = resolve({ activeProfileId: null })
    expect(nothing.effectiveConnectionId).toBeNull()
    expect(nothing.profile).toBeNull()
    expect(nothing.overrideSource).toBeNull()
  })

  test('the effective profile object matches the effective id', () => {
    const result = resolve({ activeCharacterConnectionId: 'charbound' })
    expect(result.profile?.id).toBe('charbound')
    expect(result.profile?.name).toBe('Profile charbound')
  })
})
