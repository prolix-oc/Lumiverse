/// <reference types="bun-types" />

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

  test('leaves valid <json> blocks untouched', () => {
    const ctx = { charName: 'Assistant', userName: 'User' }
    const block = '<json>{"who": "{{user}}", "legacy": "<USER>", "set": "{{setvar::x::y}}"}</json>'
    expect(resolveDisplayMacros(`{{user}} <BOT> ${block}{{setvar::a::b}}`, ctx)).toBe(`User Assistant ${block}`)
    expect(stripDisplaySetterMacros(`${block}{{setvar::a::b}}`)).toBe(block)
    // Not JSON, so its macros resolve as usual.
    expect(resolveDisplayMacros('<json>{{user}}</json>', ctx)).toBe('<json>User</json>')
  })
})


test('restores literal data after display macros and setter stripping finish', () => {
  const open = '\x00LUMIVERSE_LITERAL_BRACE_OPEN_7f37c911\x00'
  const close = '\x00LUMIVERSE_LITERAL_BRACE_CLOSE_7f37c911\x00'
  const data = `${open}${open}user${close}${close}|${open}${open}setchatvar::owned::yes${close}${close}`
  const ctx = { charName: 'Assistant', userName: 'User' }
  expect(resolveDisplayMacros(data, ctx)).toBe('{{user}}|{{setchatvar::owned::yes}}')
  expect(resolveDisplayMacros(`${data} {{user}}`, ctx)).toBe('{{user}}|{{setchatvar::owned::yes}} User')
})

test('leaves valid JSON after malformed shorthand verbatim', () => {
  const source = '{{.x ignored <json>{"s":"{{user}}"}</json>'
  expect(resolveDisplayMacros(source, { charName: 'Assistant', userName: 'User' })).toBe(source)
})
