import { beforeEach, describe, expect, test } from 'bun:test'
import {
  claimLocalRegexAction,
  claimLocalRegexActions,
  applyRegexActionDraft,
  consumeRegexActionDraft,
  consumeRegexSelections,
  getPendingRegexSelections,
  toggleRegexSelection,
  queueRegexActionDraft,
  type RegexActionActivation,
} from './actionBus'

const values = new Map<string, string>()
const sessionValues = new Map<string, string>()
const localStorageStub: Storage = {
  get length() { return values.size },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key) },
  setItem: (key, value) => { values.set(key, String(value)) },
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageStub,
})
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    ...localStorageStub,
    get length() { return sessionValues.size },
    clear: () => sessionValues.clear(),
    getItem: (key: string) => sessionValues.get(key) ?? null,
    key: (index: number) => [...sessionValues.keys()][index] ?? null,
    removeItem: (key: string) => { sessionValues.delete(key) },
    setItem: (key: string, value: string) => { sessionValues.set(key, String(value)) },
  } satisfies Storage,
})

function action(id: string, multiSelect = true): RegexActionActivation {
  return {
    id,
    type: id === 'hidden' ? 'append' : 'send',
    multi_select: multiSelect,
    cost: 1,
    limit: 2,
    title: id,
    subtitle: '',
    content: `${id} modifier`,
    scriptId: 'script-1',
    instanceId: 'script-1:10:20',
    chatId: 'chat-1',
    messageId: 'message-1',
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('regex action selection state', () => {
  test('stacks distinct multi-select options and consumes them together', () => {
    expect(toggleRegexSelection(action('north')).selected).toBe(true)
    expect(toggleRegexSelection(action('hidden')).selected).toBe(true)

    expect(getPendingRegexSelections('chat-1').map((item) => item.id)).toEqual(['north', 'hidden'])
    expect(consumeRegexSelections('chat-1').map((item) => item.id)).toEqual(['north', 'hidden'])
    expect(getPendingRegexSelections('chat-1')).toEqual([])
  })

  test('clicking a staged option again removes it before send', () => {
    expect(toggleRegexSelection(action('north')).selected).toBe(true)
    expect(toggleRegexSelection(action('north'))).toMatchObject({ selected: false, reason: 'removed' })
    expect(getPendingRegexSelections('chat-1')).toEqual([])
  })

  test('prevents selections whose total cost exceeds the block limit', () => {
    expect(toggleRegexSelection(action('north')).selected).toBe(true)
    expect(toggleRegexSelection({ ...action('south'), cost: 2 })).toMatchObject({ selected: false, reason: 'limit' })
    expect(getPendingRegexSelections('chat-1').map((item) => item.id)).toEqual(['north'])
  })

  test('claims multi-select options independently but never twice', () => {
    expect(claimLocalRegexAction(action('north'))).toBe(true)
    expect(claimLocalRegexAction(action('south'))).toBe(true)
    expect(claimLocalRegexAction(action('north'))).toBe(false)
    expect(claimLocalRegexAction(action('confirm', false))).toBe(false)
  })

  test('finalizes provisional local selections together at send time', () => {
    const north = action('north')
    const south = action('south')
    const confirm = action('confirm', false)
    expect(claimLocalRegexActions([north, south, confirm])).toBe(true)
    expect(claimLocalRegexActions([north])).toBe(false)
  })

  test('a single-select claim consumes the whole block', () => {
    expect(claimLocalRegexAction(action('confirm', false))).toBe(true)
    expect(toggleRegexSelection(action('north'))).toMatchObject({ selected: false, reason: 'used' })
  })
})

describe('regex action drafts', () => {
  test('replaces or appends composer content predictably', () => {
    expect(applyRegexActionDraft('Existing', { mode: 'replace', content: 'Suggested' })).toBe('Suggested')
    expect(applyRegexActionDraft('Existing', { mode: 'append', content: 'Suggested' })).toBe('Existing\n\nSuggested')
  })

  test('carries a draft across branch navigation exactly once', () => {
    queueRegexActionDraft('branch-1', { mode: 'replace', content: 'Take the rooftops.' })
    expect(consumeRegexActionDraft('branch-1')).toEqual({ mode: 'replace', content: 'Take the rooftops.' })
    expect(consumeRegexActionDraft('branch-1')).toBeNull()
  })
})
