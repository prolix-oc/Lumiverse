import { beforeEach, describe, expect, test } from 'bun:test'
import {
  claimLocalRegexAction,
  claimLocalRegexActions,
  consumeRegexSelections,
  getPendingRegexSelections,
  toggleRegexSelection,
  type RegexActionActivation,
} from './actionBus'

const values = new Map<string, string>()
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

beforeEach(() => localStorage.clear())

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
