import { describe, expect, test } from 'bun:test'
import { resolveDisplayMacros, stripDisplaySetterMacros } from './resolveDisplayMacros'

describe('resolveDisplayMacros', () => {
  test('strips setter macros from displayed bubble content', () => {
    expect(stripDisplaySetterMacros('Before {{setvar::scene::alley}} after')).toBe('Before  after')
    expect(resolveDisplayMacros('Mood {{setchatvar::mood::calm}} for {{user}}', {
      charName: 'Assistant',
      userName: 'User',
    })).toBe('Mood  for User')
  })
})
