import { describe, expect, test } from 'bun:test'
import { splitJsonBlocks } from './jsonBlocks'
import { stripDisplaySetterMacros } from './resolveDisplayMacros'

describe('splitJsonBlocks', () => {
  test('splits out only blocks whose inner text parses as JSON', () => {
    expect(splitJsonBlocks('a <json> draft <json>{"hp": 3}</json> <json>{{getchatvar::state}}</json>')).toEqual([
      { text: 'a <json> draft ', verbatim: false },
      { text: '<json>{"hp": 3}</json>', verbatim: true },
      { text: ' <json>{{getchatvar::state}}</json>', verbatim: false },
    ])
  })

  test('never lets stray openers hide a later valid block', () => {
    const block = '<json>{"x":"{{setchatvar::owned::yes}}"}</json>'

    // Each stray opener starts like JSON and shares the block's closer.
    expect(splitJsonBlocks(`${'<json>0 '.repeat(16)}${block}`)).toEqual([
      { text: '<json>0 '.repeat(16), verbatim: false },
      { text: block, verbatim: true },
    ])
  })

  test('JSON strings may hold either tag', () => {
    const block = '<json>{"tag":"<json>","x":"{{setchatvar::owned::yes}}"}</json>'

    expect(splitJsonBlocks(block)).toEqual([{ text: block, verbatim: true }])
    // Display setters leave the macro text in its strings alone.
    expect(stripDisplaySetterMacros(block)).toBe(block)
    expect(splitJsonBlocks('<json>"a</json>b"</json>')).toEqual([{ text: '<json>"a</json>b"</json>', verbatim: true }])
  })

  test('a stray opener in prose, even one before a quote, does not hide a later block', () => {
    expect(splitJsonBlocks('I said "<json>" is a tag. <json>{"a":1}</json>')).toEqual([
      { text: 'I said "<json>" is a tag. ', verbatim: false },
      { text: '<json>{"a":1}</json>', verbatim: true },
    ])
  })

  test('a block inside a macro tag is the tag\'s text, so a display setter strips the whole tag', () => {
    const block = '<json>{"a":1}</json>'

    expect(splitJsonBlocks(`{{setvar::x::${block}}}${block}`)).toEqual([
      { text: `{{setvar::x::${block}}}`, verbatim: false },
      { text: block, verbatim: true },
    ])
    expect(stripDisplaySetterMacros(`{{setvar::x::${block}}}${block}`)).toBe(block)
    // A `}}` in the JSON closes the tag there, as it does for the backend.
    expect(stripDisplaySetterMacros('{{setvar::x::<json>{"a":{"b":1}}</json>}}')).toBe('</json>}}')
  })

  test('counts macro tags as the backend lexer reads them', () => {
    const block = '<json>1</json>'

    // A scoped body is outside every tag.
    expect(splitJsonBlocks(`{{setchatvar::state}}${block}{{/setchatvar}}`)).toEqual([
      { text: '{{setchatvar::state}}', verbatim: false },
      { text: block, verbatim: true },
      { text: '{{/setchatvar}}', verbatim: false },
    ])
    // `\{` and `\}` are literal braces, and a `}}` outside every tag is plain text.
    expect(splitJsonBlocks(String.raw`\{\{ ${block}`).map((segment) => segment.verbatim)).toEqual([false, true])
    expect(splitJsonBlocks(`}} ${block} }}{{x::${block}}}`).map((segment) => segment.verbatim)).toEqual([
      false,
      true,
      false,
    ])
    // The block's own `}}` closes the tag around it, as the lexer reads it.
    expect(splitJsonBlocks(`{{x::<json>{"a":{"b":1}}</json>}} ${block}`).map((segment) => segment.verbatim)).toEqual([
      false,
      true,
    ])
  })

  test('a block after a tag that text inside it closed early stays verbatim, as the backend holds it out', () => {
    const block = '<json>{"x":"{{setchatvar::owned::yes}}"}</json>'
    // The lexer closes {{setvar}} at the first block's `}}`, so the second block is outside every tag.
    const closed = `{{setvar::v::<json>{"a":{}}</json>${block}`
    // The tag closes inside a block's string, so an opener later in that string is outside every tag.
    const reopened = '{{setvar::v::<json>["}}<json>["]</json>{{setchatvar::owned::yes}}"]</json>'

    expect(splitJsonBlocks(closed)).toEqual([
      { text: '{{setvar::v::<json>{"a":{}}</json>', verbatim: false },
      { text: block, verbatim: true },
    ])
    expect(stripDisplaySetterMacros(closed)).toBe(`</json>${block}`)
    expect(splitJsonBlocks(reopened)).toEqual([
      { text: '{{setvar::v::<json>["}}', verbatim: false },
      { text: '<json>["]</json>{{setchatvar::owned::yes}}"]</json>', verbatim: true },
    ])
    expect(stripDisplaySetterMacros(reopened)).toBe('<json>["]</json>{{setchatvar::owned::yes}}"]</json>')
  })

  test('past the rejected-candidate cap, the rest of the text stays verbatim, as the backend leaves it', () => {
    const stray = '<json>bad</json>'
    const text = `${stray.repeat(256)}<json>{"x":"{{setchatvar::owned::yes}}"}</json>`

    // The 256th rejected candidate stops the scan, so the block after it is never classified.
    expect(splitJsonBlocks(text)).toEqual([
      { text: stray.repeat(255), verbatim: false },
      { text: text.slice(stray.length * 255), verbatim: true },
    ])
    expect(stripDisplaySetterMacros(text)).toBe(text)
  })

  test('scans adversarial runs of openers in linear time', () => {
    const n = 20_000
    const started = performance.now()

    // Openers that share one closer: each one sits outside the strings of the
    // one before, so the scan moves on to it without parsing.
    expect(splitJsonBlocks(`${'<json>'.repeat(n)}0</json>`)).toEqual([
      { text: '<json>'.repeat(n - 1), verbatim: false },
      { text: '<json>0</json>', verbatim: true },
    ])
    expect(splitJsonBlocks(`${'<json>0'.repeat(n)}</json>`)).toEqual([
      { text: '<json>0'.repeat(n - 1), verbatim: false },
      { text: '<json>0</json>', verbatim: true },
    ])
    // Each opener's quote holds the next opener in a string.
    expect(splitJsonBlocks('<json>"'.repeat(n))).toEqual([{ text: '<json>"'.repeat(n), verbatim: false }])
    expect(splitJsonBlocks(`${'<json>"'.repeat(n)}</json>`)).toEqual([
      { text: '<json>"'.repeat(n - 2), verbatim: false },
      { text: '<json>"<json>"</json>', verbatim: true },
    ])
    expect(performance.now() - started).toBeLessThan(250)
  })

  test('keeps the text after too many rejected candidates verbatim, in linear time', () => {
    const block = '<json>{"a":1}</json>'
    // Escaped quotes keep every opener's string open to the end of the text,
    // so each opener is rejected only after a scan to the end.
    const opener = '\\"<json>'
    const crafted = `<json>"${opener.repeat(20_000)}${block}`
    // The first opener is rejected, then each one in the run: the 255th reaches the cap.
    const stoppedAt = `<json>"${opener.repeat(254)}\\"`.length

    expect(splitJsonBlocks(`<json>"${opener.repeat(100)}${block}`).map((segment) => segment.verbatim)).toEqual([
      false,
      true,
    ])
    const started = performance.now()
    expect(splitJsonBlocks(crafted)).toEqual([
      { text: crafted.slice(0, stoppedAt), verbatim: false },
      { text: crafted.slice(stoppedAt), verbatim: true },
    ])
    expect(performance.now() - started).toBeLessThan(250)
  })
})


test('keeps the whole message verbatim when malformed shorthand may close early', () => {
  const source = '{{.x ignored <json>{"s":"{{user}}"}</json>'
  expect(splitJsonBlocks(source)).toEqual([{ text: source, verbatim: true }])
})
