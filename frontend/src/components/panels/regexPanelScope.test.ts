import { describe, expect, it } from 'bun:test'

import { resolveRegexCreateScope } from './regexPanelScope'

describe('resolveRegexCreateScope', () => {
  it('creates a global regex for non-scoped filters', () => {
    expect(resolveRegexCreateScope('all', 'char-1', 'chat-1')).toEqual({
      ok: true,
      input: {
        scope: 'global',
        scope_id: null,
      },
    })
    expect(resolveRegexCreateScope('global', 'char-1', 'chat-1')).toEqual({
      ok: true,
      input: {
        scope: 'global',
        scope_id: null,
      },
    })
    expect(resolveRegexCreateScope('preset', 'char-1', 'chat-1')).toEqual({
      ok: true,
      input: {
        scope: 'global',
        scope_id: null,
      },
    })
  })

  it('creates a character-scoped regex when the character filter is active', () => {
    expect(resolveRegexCreateScope('character', 'char-1', 'chat-1')).toEqual({
      ok: true,
      input: {
        scope: 'character',
        scope_id: 'char-1',
      },
    })
  })

  it('creates a chat-scoped regex when the chat filter is active', () => {
    expect(resolveRegexCreateScope('chat', 'char-1', 'chat-1')).toEqual({
      ok: true,
      input: {
        scope: 'chat',
        scope_id: 'chat-1',
      },
    })
  })

  it('returns an error when the scoped context is missing', () => {
    expect(resolveRegexCreateScope('character', null, 'chat-1')).toEqual({
      ok: false,
      error: 'missingCharacter',
    })
    expect(resolveRegexCreateScope('chat', 'char-1', null)).toEqual({
      ok: false,
      error: 'missingChat',
    })
  })
})
