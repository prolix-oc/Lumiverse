/// <reference types="bun-types" />

import { expect, test } from 'bun:test'
import { normalizeLegacyFontTags } from './legacyFontTags'

test('preserves inline styles when converting legacy font tags', () => {
  expect(
    normalizeLegacyFontTags('<font color="#E8534A" style="font-weight:bold">Alert</font>'),
  ).toBe('<span style="color:#E8534A;font-weight:bold">Alert</span>')
})

test('keeps a font style when no color attribute is present', () => {
  expect(normalizeLegacyFontTags('<font style="font-style:italic">Note</font>'))
    .toBe('<span style="font-style:italic">Note</span>')
})

test('heals 5-digit hex colors into valid 6-digit CSS hex colors', () => {
  expect(normalizeLegacyFontTags('<font color="#7FA83">"Bored."</font>'))
    .toBe('<span style="color:#7FA830">"Bored."</span>')
  expect(normalizeLegacyFontTags('<font color="7FA83">"Bored."</font>'))
    .toBe('<span style="color:#7FA830">"Bored."</span>')
  expect(normalizeLegacyFontTags('<font color="#7FA86">Text</font>'))
    .toBe('<span style="color:#7FA860">Text</span>')
})

test('safely handles edge case color attributes', () => {
  // Other malformed lengths need the full legacy color algorithm and must not
  // be guessed at by this narrowly scoped five-digit repair.
  expect(normalizeLegacyFontTags('<font color="#E8534A0">Notice</font>'))
    .toBe('<span style="color:#E8534A0">Notice</span>')
  expect(normalizeLegacyFontTags('<font color="#123456789">Long</font>'))
    .toBe('<span style="color:#123456789">Long</span>')
  expect(normalizeLegacyFontTags('<font color="#ff">Short</font>'))
    .toBe('<span style="color:#ff">Short</span>')
  // Lone '#' does not emit invalid color:#
  expect(normalizeLegacyFontTags('<font color="#">Empty</font>'))
    .toBe('<span>Empty</span>')
  // Standard CSS named colors and rgb expressions are preserved
  expect(normalizeLegacyFontTags('<font color="tomato">Red</font>'))
    .toBe('<span style="color:tomato">Red</span>')
  expect(normalizeLegacyFontTags('<font color="rgb(255, 0, 0)">RGB</font>'))
    .toBe('<span style="color:rgb(255, 0, 0)">RGB</span>')
})

test.each([
  ["case and unquoted color", "<FONT COLOR=red>Text</FONT>", "<span style=\"color:red\">Text</span>"],
  ["quoted delimiter", "<font title=\"a>b\" color=\"red\">Text</font>", "<span>b\" color=\"red\">Text</span>"],
  ["nested opening prefix", "<font x=<font color=\"red\">Text</font>", "<span style=\"color:red\">Text</span>"],
  ["style escaping", "<font style=\"font-family: &quot;Example&quot;\">Text</font>", "<span style=\"font-family: &amp;quot;Example&amp;quot;\">Text</span>"],
  ["closing tag whitespace", "<font color=red>Text</font \n>", "<span style=\"color:red\">Text</span>"],
  ["unfinished opening", "<font color=\"red\"", "<font color=\"red\""],
  ["longer tag name", "<font_extra color=red>Text</font_extra>", "<font_extra color=red>Text</font_extra>"],
  ["unsupported color punctuation", "<font color=\"red;position:fixed\">Text</font>", "<span>Text</span>"],
])('preserves legacy fonts behavior for %s', (_name, input, expected) => {
  expect(normalizeLegacyFontTags(input)).toBe(expected)
})

test('leaves repeated unfinished font tags unchanged', () => {
  const input = '<!--' + '<font '.repeat(256)
  expect(normalizeLegacyFontTags(input)).toBe(input)
})
