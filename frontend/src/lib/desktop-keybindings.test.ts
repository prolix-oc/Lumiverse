import { expect, test } from 'bun:test'
import { commandScopeActive, isCompleteDesktopChord, matchingBinding, type DesktopBinding } from './desktop-keybindings'

const binding: DesktopBinding = { id: 'analyze', scope: 'focused', chord: { code: 'KeyP', ctrl: true, shift: true, alt: false, meta: false } }
const event = { code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false }
test('matches physical keys with exactly the configured modifiers', () => {
  expect(matchingBinding([binding], event)).toBe(binding)
  expect(matchingBinding([binding], { ...event, shiftKey: false })).toBeUndefined()
  expect(matchingBinding([binding], { ...event, metaKey: true })).toBeUndefined()
  expect(matchingBinding([binding], { ...event, code: 'KeyQ' })).toBeUndefined()
  expect(matchingBinding([binding], { ...event, isComposing: true })).toBeUndefined()
})
test('identifies native global bindings so the DOM default can be suppressed without another trigger', () => {
  expect(matchingBinding([{ ...binding, scope: 'global' }], event)?.scope).toBe('global')
})

test('F13–F24 support standalone and modified chords with exact event matching', () => {
  for (let number = 13; number <= 24; number++) {
    const chord = { code: `F${number}`, ctrl: false, alt: false, shift: false, meta: false }
    expect(isCompleteDesktopChord(chord)).toBe(true)
    expect(isCompleteDesktopChord({ ...chord, shift: true })).toBe(true)
    expect(isCompleteDesktopChord({ ...chord, ctrl: true })).toBe(true)
    const binding: DesktopBinding = { id: chord.code, scope: 'global', chord }
    const event = { code: chord.code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false }
    expect(matchingBinding([binding], event)).toBe(binding)
    expect(matchingBinding([binding], { ...event, shiftKey: true })).toBeUndefined()
  }
})

test('ordinary keys still require modifiers and unsupported codes cannot be saved', () => {
  const chord = { code: '', ctrl: false, alt: false, shift: false, meta: false }
  for (const code of ['F1', 'F12', 'KeyP', 'Digit1', 'Space', 'Enter', 'ArrowUp']) {
    expect(isCompleteDesktopChord({ ...chord, code })).toBe(false)
    expect(isCompleteDesktopChord({ ...chord, code, shift: true })).toBe(false)
    expect(isCompleteDesktopChord({ ...chord, code, ctrl: true })).toBe(true)
  }
  for (const code of ['', 'F0', 'F25', 'F013', 'ShiftLeft']) {
    expect(isCompleteDesktopChord({ ...chord, code, ctrl: true })).toBe(false)
  }
})
test('key bindings preserve command palette context guards', () => {
  expect(commandScopeActive('chat-idle', '/chat/current', false, 2)).toBe(true)
  expect(commandScopeActive('chat-idle', '/chat/current', true, 2)).toBe(false)
  expect(commandScopeActive('chat-idle', '/', false, 2)).toBe(false)
  expect(commandScopeActive('chat-idle', '/chat/current', false, 0)).toBe(false)
  expect(commandScopeActive('chat', '/chat/current', true, 0)).toBe(true)
  expect(commandScopeActive('character', '/characters/current', false, 0)).toBe(true)
  expect(commandScopeActive('landing', '/characters/current', false, 0)).toBe(false)
})
