import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'zustand/vanilla'
import { createExpressionSlice } from '@/store/slices/expressions'
import type { Character } from '@/types/api'
import type { ExpressionConfig } from '@/types/expressions'
import { resolveExpression, resolveMessageExpressionImageId } from './expressionResolution'

function fixture(id = 'char-a', useAsAvatar = true) {
  const config: ExpressionConfig = {
    enabled: true, useAsAvatar, defaultExpression: 'neutral',
    mappings: { neutral: `${id}-neutral`, happy: `${id}-happy` },
  }
  const character: Pick<Character, 'id' | 'extensions'> = { id, extensions: { expressions: config } }
  const store = createStore(createExpressionSlice)
  const state = () => ({ ...store.getState(), activeChatId: 'chat', isGroupChat: false })
  const avatar = (isUser = false) => resolveMessageExpressionImageId(state(), character, id, 'chat', isUser)
  return { character, config, store, state, avatar }
}

describe('expression message-avatar resolution', () => {
  test('legacy/disabled preferences leave ordinary artwork even with an active sprite', () => {
    const f = fixture('char-a', false)
    f.store.getState().setActiveExpression('happy', 'char-a-happy', 'char-a')
    expect(f.avatar()).toBeNull()
    delete f.config.useAsAvatar
    expect(f.avatar()).toBeNull()
    f.config.useAsAvatar = true
    f.config.enabled = false
    expect(f.avatar()).toBeNull()
  })

  test('uses the event-resolved image and reacts to the existing expression slice', () => {
    const f = fixture()
    const updates: Array<string | null> = []
    const unsubscribe = f.store.subscribe(() => updates.push(f.avatar()))
    // These are the actions called by the existing EXPRESSION_CHANGED handler.
    f.store.getState().setActiveExpression('happy', 'char-a-happy', 'char-a')
    f.store.getState().setActiveExpression('neutral', 'char-a-neutral', 'char-a')
    expect(updates).toEqual(['char-a-happy', 'char-a-neutral'])
    unsubscribe()
  })

  test('shares the detached display default/first-mapping fallback', () => {
    const f = fixture()
    expect(f.avatar()).toBe(resolveExpression(f.config)?.imageId)
    expect(f.avatar()).toBe('char-a-neutral')
    f.config.defaultExpression = ''
    expect(f.avatar()).toBe(resolveExpression(f.config)?.imageId)
    f.config.mappings = {}
    expect(f.avatar()).toBeNull()
  })

  test('missing, empty, or replaced active/default mappings fall back to ordinary artwork', () => {
    const f = fixture()
    for (const [label, imageId] of [['missing', 'old-image'], ['happy', 'old-image'], ['happy', '']]) {
      f.store.getState().setActiveExpression(label, imageId, 'char-a')
      expect(f.avatar()).toBeNull()
    }
    f.store.getState().setActiveExpression(null, null, null)
    f.config.defaultExpression = 'removed'
    expect(f.avatar()).toBeNull()
    f.config.defaultExpression = 'neutral'
    f.config.mappings.neutral = ''
    expect(f.avatar()).toBeNull()
  })

  test('user/persona messages, other chats, and unknown characters are unaffected', () => {
    const f = fixture()
    f.store.getState().setActiveExpression('happy', 'char-a-happy', 'char-a')
    expect(f.avatar(true)).toBeNull()
    expect(resolveMessageExpressionImageId(f.state(), f.character, 'char-a', 'other-chat', false)).toBeNull()
    expect(resolveMessageExpressionImageId(f.state(), f.character, 'missing-character', 'chat', false)).toBeNull()
    delete f.character.extensions.expressions
    expect(f.avatar()).toBeNull()
  })

  test('isolates group chat members instead of using the latest global speaker', () => {
    const a = fixture('char-a')
    const b = fixture('char-b')
    a.store.getState().setActiveExpression('happy', 'char-a-happy', 'char-a')
    a.store.getState().setGroupExpression('char-a', 'happy', 'char-a-happy')
    const state = { ...a.state(), isGroupChat: true }
    expect(resolveMessageExpressionImageId(state, a.character, 'char-a', 'chat', false)).toBe('char-a-happy')
    expect(resolveMessageExpressionImageId(state, b.character, 'char-b', 'chat', false)).toBe('char-b-neutral')
    a.store.getState().setGroupExpression('char-b', 'happy', 'char-b-happy')
    const updated = { ...a.state(), isGroupChat: true }
    expect(resolveMessageExpressionImageId(updated, b.character, 'char-b', 'chat', false)).toBe('char-b-happy')
    expect(resolveMessageExpressionImageId(updated, a.character, 'char-a', 'chat', false)).toBe('char-a-happy')
  })

  test('does not borrow another character’s single-chat expression', () => {
    const f = fixture()
    f.store.getState().setActiveExpression('happy', 'other-happy', 'other')
    expect(f.avatar()).toBe('char-a-neutral')
  })

  test('multi-character cards retain ordinary artwork, including in group chats', () => {
    const f = fixture()
    f.character.extensions.expression_groups = { Alice: { happy: 'alice-happy' }, Bob: { happy: 'bob-happy' } }
    f.store.getState().setActiveExpression('happy', 'char-a-happy', 'char-a')
    f.store.getState().setMultiCharacterExpressions({ Alice: { label: 'happy', imageId: 'alice-happy' } })
    expect(f.avatar()).toBeNull()
    expect(resolveMessageExpressionImageId({ ...f.state(), isGroupChat: true }, f.character, 'char-a', 'chat', false)).toBeNull()
  })

  test('both display and message surface consume the shared resolution boundary', () => {
    const display = readFileSync(new URL('../components/chat/expressions/ExpressionDisplay.tsx', import.meta.url), 'utf8')
    const message = readFileSync(new URL('../hooks/useMessageCard.ts', import.meta.url), 'utf8')
    expect(display).toContain('resolveExpression(exprConfig,')
    expect(display).toContain('resolveExpression(groupConfigs.get(charId), groupExpressions[charId])')
    expect(message).toContain('resolveMessageExpressionImageId(')
    expect(message).toContain('const expressionAvatarImageId = useStore(')
  })
})
