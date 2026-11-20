/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import { createUISlice, SETTINGS_ACTIVE_VIEW_STORAGE_KEY } from './ui'
import type { UISlice } from '@/types/store'

function createUIStore() {
  return createStore<UISlice>()(createUISlice)
}

const draft = {
  chatId: 'chat-1',
  messageId: 'message-20',
  messageOffset: 19,
  messageIndexInChat: 20,
  content: 'original',
  reasoning: '',
  showReasoningEditor: false,
  hadReasoning: false,
}

describe('message edit draft lifecycle', () => {
  test('keeps draft content when an editor is deactivated and resumed', () => {
    const store = createUIStore()

    store.getState().beginMessageEdit(draft)
    store.getState().updateMessageEditDraft({ content: 'unsaved change' })
    store.getState().setEditingMessageId(null)

    expect(store.getState().editingMessageId).toBeNull()
    expect(store.getState().messageEditDraft?.content).toBe('unsaved change')
    expect(store.getState().messageEditDraft?.dirty).toBe(true)

    store.getState().resumeMessageEdit()
    expect(store.getState().editingMessageId).toBe(draft.messageId)
    expect(store.getState().messageEditDraft?.focusRequested).toBe(true)
  })

  test('consumes remount focus separately from clearing the draft', () => {
    const store = createUIStore()

    store.getState().beginMessageEdit(draft)
    store.getState().consumeMessageEditFocusRequest()

    expect(store.getState().messageEditDraft?.focusRequested).toBe(false)
    expect(store.getState().messageEditDraft?.content).toBe('original')

    store.getState().clearMessageEdit()
    expect(store.getState().editingMessageId).toBeNull()
    expect(store.getState().messageEditDraft).toBeNull()
  })
})

describe('settings navigation persistence', () => {
  test('reopens the last selected settings view on this device', () => {
    localStorage.removeItem(SETTINGS_ACTIVE_VIEW_STORAGE_KEY)
    const store = createUIStore()

    store.getState().setSettingsActiveView('voice')
    store.getState().closeSettings()
    store.getState().openSettings()

    expect(store.getState().settingsActiveView).toBe('voice')
    expect(localStorage.getItem(SETTINGS_ACTIVE_VIEW_STORAGE_KEY)).toBe('voice')
  })

  test('restores the remembered view for a new store instance', () => {
    localStorage.setItem(SETTINGS_ACTIVE_VIEW_STORAGE_KEY, 'productivity')

    expect(createUIStore().getState().settingsActiveView).toBe('productivity')

    localStorage.removeItem(SETTINGS_ACTIVE_VIEW_STORAGE_KEY)
  })
})
