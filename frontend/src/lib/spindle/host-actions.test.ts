import { describe, expect, test } from 'bun:test'
import {
  applyHostAction,
  HOST_ROUTE_PATTERNS,
  type HostActionRuntime,
} from './host-actions'

function runtime(overrides: Partial<HostActionRuntime> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const base: HostActionRuntime = {
    openDrawer: (id) => { calls.push(['openDrawer', id]) },
    closeDrawer: () => { calls.push(['closeDrawer']) },
    openSettings: (id, anchor) => { calls.push(['openSettings', id, anchor]) },
    closeSettings: () => { calls.push(['closeSettings']) },
    openCommandPalette: () => { calls.push(['openCommandPalette']) },
    closeCommandPalette: () => { calls.push(['closeCommandPalette']) },
    runCommand: (id) => { calls.push(['runCommand', id]) },
    navigate: (path) => { calls.push(['navigate', path]) },
    setEditingCharacterId: (id) => { calls.push(['setEditingCharacterId', id]) },
    openWorldBookEditor: (id, entryId) => { calls.push(['openWorldBookEditor', id, entryId]) },
    invokeInputBarAction: (id) => { calls.push(['invokeInputBarAction', id]) },
    invokeExtensionCommand: (id) => { calls.push(['invokeExtensionCommand', id]) },
    switchPersona: (id) => { calls.push(['switchPersona', id]) },
    switchPreset: (id) => { calls.push(['switchPreset', id]) },
    applyTheme: (id) => { calls.push(['applyTheme', id]) },
    openCharacterChat: (id, mode) => { calls.push(['openCharacterChat', id, mode]) },
  }
  return { calls, runtime: { ...base, ...overrides } }
}

describe('H4 host action switch', () => {
  test('keeps the route allowlist explicit and builds encoded ids', () => {
    expect(HOST_ROUTE_PATTERNS).toEqual(['/', '/chat/:chatId', '/characters', '/characters/:id'])
    const { calls, runtime: host } = runtime()
    applyHostAction({ kind: 'route', id: '/characters/:id' }, { id: 'A_B-7' }, host)
    expect(calls).toEqual([['navigate', '/characters/A_B-7']])
    expect(() => applyHostAction({ kind: 'route', id: 'https://evil.test' }, {}, host)).toThrow('HOST_ACTION_INVALID_ROUTE')
    expect(() => applyHostAction({ kind: 'route', id: '/characters/:id' }, { id: '../secret' }, host)).toThrow('HOST_ACTION_INVALID_ID')
    expect(() => applyHostAction({ kind: 'route', id: '/characters/:id' }, { id: 'a/b' }, host)).toThrow('HOST_ACTION_INVALID_ID')
    expect(() => applyHostAction({ kind: 'route', id: '/characters/:id' }, { id: 'a'.repeat(65) }, host)).toThrow('HOST_ACTION_INVALID_ID')
  })

  test('dispatches every host-owned action kind to its typed runtime leaf', async () => {
    const { calls, runtime: host } = runtime()
    applyHostAction({ kind: 'drawer_tab', id: 'profile' }, undefined, host)
    applyHostAction({ kind: 'settings_tab', id: 'voice' }, { anchorId: 'voice.stt' }, host)
    applyHostAction({ kind: 'command', id: 'action-new-chat' }, undefined, host)
    applyHostAction({ kind: 'modal', id: 'character_editor' }, { id: 'char-1' }, host)
    applyHostAction({ kind: 'modal', id: 'world_book_editor' }, { id: 'book-1', entryId: 'entry-1' }, host)
    await applyHostAction({ kind: 'input_bar_action', id: 'action-1' }, undefined, host)
    applyHostAction({ kind: 'ext_command', id: 'ext-cmd-other-command' }, undefined, host)
    expect(calls).toEqual([
      ['openDrawer', 'profile'],
      ['openSettings', 'voice', 'voice.stt'],
      ['runCommand', 'action-new-chat'],
      ['setEditingCharacterId', 'char-1'],
      ['openWorldBookEditor', 'book-1', 'entry-1'],
      ['invokeInputBarAction', 'action-1'],
      ['invokeExtensionCommand', 'ext-cmd-other-command'],
    ])
  })

  test('rejects arbitrary modal names and caller-supplied command params', () => {
    const { runtime: host } = runtime()
    expect(() => applyHostAction({ kind: 'modal', id: 'confirm' as never }, {}, host)).toThrow('HOST_ACTION_UNMAPPED')
    expect(() => applyHostAction({ kind: 'modal', id: 'character_editor' }, { id: 'char-1', entryId: 'entry-1' }, host)).toThrow('HOST_ACTION_INVALID_PARAMS')
    expect(() => applyHostAction({ kind: 'modal', id: 'world_book_editor' }, { id: 'book-1', entryId: '../entry' }, host)).toThrow('HOST_ACTION_INVALID_ID')
    expect(() => applyHostAction({ kind: 'command', id: 'action-new-chat' }, { params: 'unsafe' }, host)).toThrow('HOST_ACTION_INVALID_PARAMS')
  })

  test('entity actions pass validated params to their runtime leaf', () => {
    const { calls, runtime: host } = runtime()
    applyHostAction({ kind: 'entity_action', id: 'switch_persona' }, { personaId: 'persona-1' }, host)
    applyHostAction({ kind: 'entity_action', id: 'switch_preset' }, { presetId: 'preset-1' }, host)
    applyHostAction({ kind: 'entity_action', id: 'apply_theme' }, { themeId: 'midnight-blue' }, host)
    applyHostAction({ kind: 'entity_action', id: 'character_chat' }, { characterId: 'char-1', mode: 'latest' }, host)
    applyHostAction({ kind: 'entity_action', id: 'character_chat' }, { characterId: 'char-1', mode: 'new' }, host)
    expect(calls).toEqual([
      ['switchPersona', 'persona-1'],
      ['switchPreset', 'preset-1'],
      ['applyTheme', 'midnight-blue'],
      ['openCharacterChat', 'char-1', 'latest'],
      ['openCharacterChat', 'char-1', 'new'],
    ])
  })

  test('entity actions reject missing, unsafe, and extra params and unknown ids', () => {
    const { calls, runtime: host } = runtime()
    const act = (id: string, params?: Record<string, string>) => () => applyHostAction({ kind: 'entity_action', id }, params, host)
    expect(act('switch_persona')).toThrow('HOST_ACTION_INVALID_ID:personaId')
    expect(act('switch_preset', { presetId: '../x' })).toThrow('HOST_ACTION_INVALID_ID:presetId')
    expect(act('apply_theme', { themeId: 'rose', css: 'x' })).toThrow('HOST_ACTION_INVALID_PARAMS:css')
    expect(act('character_chat', { characterId: 'char-1' })).toThrow('HOST_ACTION_INVALID_PARAMS:mode')
    expect(act('character_chat', { characterId: 'char-1', mode: 'oldest' })).toThrow('HOST_ACTION_INVALID_PARAMS:mode')
    expect(act('delete_persona', { personaId: 'persona-1' })).toThrow('HOST_ACTION_UNMAPPED')
    expect(calls).toEqual([])
  })
})
