/// <reference types="bun-types" />

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getConnectionEditorState,
  getEditedConnectionProfileId,
  notifyConnectionEditorSaved,
  resetConnectionEditorState,
  subscribeConnectionEditorSaved,
  subscribeConnectionEditorState,
  syncConnectionEditorState,
} from './connection-editor-helper'

describe('connection editor helper', () => {
  beforeEach(() => {
    resetConnectionEditorState()
  })

  test('starts with the safe new-editor projection', () => {
    expect(getConnectionEditorState()).toEqual({
      profileId: null,
      provider: null,
      isNew: true,
    })
    expect(getEditedConnectionProfileId()).toBeNull()

    syncConnectionEditorState({ profileId: 'ignored', provider: 'ignored', isNew: true })
    expect(getConnectionEditorState()).toEqual({ profileId: null, provider: null, isNew: true })
  })

  test('projects an existing profile and resets when the editor identity changes', () => {
    const states: Array<ReturnType<typeof getConnectionEditorState>> = []
    const unsubscribe = subscribeConnectionEditorState((state) => states.push(state))

    syncConnectionEditorState({ profileId: 'profile-a', provider: 'openai', isNew: false })
    expect(getConnectionEditorState()).toEqual({
      profileId: 'profile-a',
      provider: 'openai',
      isNew: false,
    })

    syncConnectionEditorState({ profileId: null, provider: null, isNew: true })
    expect(getConnectionEditorState()).toEqual({
      profileId: null,
      provider: null,
      isNew: true,
    })
    expect(states).toEqual([
      { profileId: 'profile-a', provider: 'openai', isNew: false },
      { profileId: null, provider: null, isNew: true },
    ])
    unsubscribe()
  })

  test('delivers one saved event to a current subscriber', () => {
    const saved: string[] = []
    const unsubscribe = subscribeConnectionEditorSaved((profileId) => saved.push(profileId))

    notifyConnectionEditorSaved('profile-a')

    expect(saved).toEqual(['profile-a'])
    unsubscribe()
    notifyConnectionEditorSaved('profile-b')
    expect(saved).toEqual(['profile-a'])
  })
})
