import { describe, expect, test } from 'bun:test'
import { formatActivationValues, parseActivationValues } from './activation-values'

describe('activation Equals list editing', () => {
  test('accepts single values, commas, newlines, and mixed lists', () => {
    expect(parseActivationValues(' combat ')).toEqual(['combat'])
    expect(parseActivationValues('combat, fight\nbattle\r\nattack, ')).toEqual(['combat', 'fight', 'battle', 'attack'])
    expect(parseActivationValues(', \n,')).toEqual([])
    expect(parseActivationValues('0, false')).toEqual(['0', 'false'])
  })
  test('supports literal delimiters and escaped quotes without splitting quoted entries', () => {
    expect(parseActivationValues('"hello, world", "say ""go""", "two\nlines"')).toEqual(['hello, world', 'say "go"', 'two\nlines'])
    expect(parseActivationValues(' "hello, world" , combat')).toEqual(['hello, world', 'combat'])
  })
  test('rejects unfinished or improperly separated quotes instead of using stale values', () => {
    expect(parseActivationValues('combat, "fight')).toBeNull()
    expect(parseActivationValues('"combat"fight')).toBeNull()
  })
  test('formats arrays and legacy literal strings without changing their meaning', () => {
    for (const input of ['combat', 'hello, world', 'say "go"', 'two\nlines', ['combat', 'hello, world', 'say "go"']]) {
      expect(parseActivationValues(formatActivationValues(input))).toEqual(Array.isArray(input) ? input : [input])
    }
  })
})
