import { describe, expect, test } from 'bun:test'
import { healFormattingArtifacts } from './formatHealing'

describe('healFormattingArtifacts', () => {
  test('closes unclosed font tags around dialogue and actions', () => {
    expect(healFormattingArtifacts('<font color="aaabbb>"Hey there." They said.'))
      .toBe('<font color="aaabbb">"Hey there."</font> They said.')
    expect(healFormattingArtifacts('<font color=xxxxxx>"Hey hey!" <font color=baabaa>*They look great today.*'))
      .toBe('<font color=xxxxxx>"Hey hey!"</font> <font color=baabaa>*They look great today.*</font>')
  })

  test('does not change balanced font tags', () => {
    const input = '<font color=#abc>"Hello."</font> <font color=#def>*She smiled.*</font>'
    expect(healFormattingArtifacts(input)).toBe(input)
  })

  test('preserves fenced code while healing surrounding prose', () => {
    const input = 'Use this exactly:\n```json\n{ "example": "* softly*" }\n```\n\nThen * softly*.'
    expect(healFormattingArtifacts(input)).toBe(
      'Use this exactly:\n```json\n{ "example": "* softly*" }\n```\n\nThen *softly*.',
    )
  })
})

test.each([
  ["complete fence", "Before \" spaced \".\n~~~lang\n\" protected \"\n~~~\nAfter \" spaced \".", "Before \"spaced\".\n~~~lang\n\" protected \"\n~~~\nAfter \"spaced\"."],
  ["shorter closing run", "~~~~lang\n\" protected \"\n~~~\n\" tail \"", "~~~~lang\n\" protected \"\n~~~\n\"tail\""],
  ["longest eligible run", "~~~~lang\n\" first \"\n~~~\n\" second \"\n~~~~\n\" tail \"", "~~~~lang\n\" first \"\n~~~\n\" second \"\n~~~~\n\"tail\""],
  ["longer closing run", "~~~lang\n\" spaced \"\n~~~~\n\" tail \"", "~~~lang\n\"spaced\"\n~~~~\n\"tail\""],
  ["adjacent fences", "~~~\n~~~\n\" spaced \"", "~~~\n~~~\n\"spaced\""],
  ["blank body line", "~~~\n\n~~~\n\" spaced \"", "~~~\n\n~~~\n\"spaced\""],
  ["indented opener", " ~~~\n\" spaced \"\n~~~", " ~~~\n\"spaced\"\n~~~"],
  ["closing whitespace", "~~~\n\" spaced \"\n~~~ ", "~~~\n\"spaced\"\n~~~ "],
  ["CRLF boundary", "~~~\r\n\" spaced \"\r\n~~~\r\n", "~~~\r\n\"spaced\"\r\n~~~\r\n"],
  ["CR boundary", "~~~\r\" spaced \"\r~~~", "~~~\r\"spaced\"\r~~~"],
  ["mixed markers", "```lang\n\" first \"\n~~~\n\" second \"\n```\n\" tail \"", "```lang\n\" first \"\n~~~\n\" second \"\n```\n\"tail\""],
  ["unclosed fence body", "~~~lang\n\" spaced \"", "~~~lang\n\"spaced\""],
])('preserves healing fences behavior for %s', (_name, input, expected) => {
  expect(healFormattingArtifacts(input)).toBe(expected)
})

test('leaves repeated unfinished fences unchanged', () => {
  const input = '```lang\nx\n'.repeat(256)
  expect(healFormattingArtifacts(input)).toBe(input)
})

test.each([
  ["ordinary inline", "Before \" spaced \". `\" protected \"` After \" spaced \".", "Before \"spaced\". `\" protected \"` After \"spaced\"."],
  ["multiline inline", "`line\n\" protected \"` Then \" spaced \".", "`line\n\" protected \"` Then \"spaced\"."],
  ["shorter closer", "````\" protected \"``` Then \" spaced \".", "````\" protected \"``` Then \"spaced\"."],
  ["longer closer remainder", "``\" first \"``` \" second \"` Then \" spaced \".", "``\" first \"``` \" second \"` Then \"spaced\"."],
  ["longest closer wins", "````\" first \"``` \" second \"```` Then \" spaced \".", "````\" first \"``` \" second \"```` Then \"spaced\"."],
  ["self close before shorter run", "``````\" spaced \"`` Then \" spaced \".", "``````\"spaced\"`` Then \"spaced\"."],
  ["odd self close remainder", "`````\" protected \"` Then \" spaced \".", "`````\" protected \"` Then \"spaced\"."],
  ["unclosed single marker", "`\" spaced \"", "`\" spaced \""],
  ["escaped markers remain matched", "\\`\" protected \"\\` Then \" spaced \".", "\\`\" protected \"\\` Then \"spaced\"."],
  ["fenced boundary", "`before\n~~~\n`\" protected \"`\n~~~\n\" spaced \"", "`before\n~~~\n`\" protected \"`\n~~~\n\"spaced\""],
])('preserves inline shielding for %s', (_name, raw, expected) => {
  expect(healFormattingArtifacts(raw)).toBe(expected)
})

test('handles a long backtick run without a later closer', () => {
  const raw = '`'.repeat(4096) + 'x'.repeat(4096)
  expect(healFormattingArtifacts(raw)).toBe(raw)
})

test.each([
  ["unfinished color quote", "<font color=\"abc>\"Hello</font>\"", "<font color=\"abc\">\"Hello\"</font>"],
  ["closing quote outside font", "<font color=\"#abc\">“Hello</font>”", "<font color=\"#abc\">“Hello”</font>"],
  ["matching quote already inside", "<font color=\"#abc\">\"Hello\"</font>\"", "<font color=\"#abc\">\"Hello\"</font>\""],
  ["nested opening prefix", "<font x=<font>\"Hello</font>\"", "<font x=<font>\"Hello\"</font>"],
  ["quoted delimiter", "<font color=\"a>b\">\" hello \"</font>\"", "<font color=\"a\">b\">\"hello\"</font>\""],
  ["single quoted color", "<font color='abc>«Hello</font>»", "<font color='abc'>«Hello»</font>"],
  ["balanced font spans", "<font color=#abc>\"Hello.\"</font> <font color=#def>*She smiled.*</font>", "<font color=#abc>\"Hello.\"</font> <font color=#def>*She smiled.*</font>"],
  ["multiple unclosed font spans", "<font color=red>\"Hello.\" Next. <font color=blue>*Action.* Tail.", "<font color=red>\"Hello.\"</font> Next. <font color=blue>*Action.*</font> Tail."],
  ["quote inside color span", "<span style=\"color:red\">“Hello</span>”", "<span style=\"color:red\">“Hello”</span>"],
  ["unfinished tail after font", "<font color=red>\"Hello.\"</font> <font ", "<font color=red>\"Hello.\"</font> <font "],
  ["longer tag name", "<font_extra>\"Hello</font_extra>\"", "<font_extra>\"Hello</font_extra>\""],
])('preserves healing fonts behavior for %s', (_name, input, expected) => {
  expect(healFormattingArtifacts(input)).toBe(expected)
})

test('leaves repeated unfinished font tags unchanged', () => {
  const input = '<!--' + '<font '.repeat(256)
  expect(healFormattingArtifacts(input)).toBe(input)
})

test.each([
  ["straight quote boundary", "\" spaced \" and \"second\".", "\"spaced\" and \"second\"."],
  ["curly and angle quote boundaries", "“ spaced ” and « spaced ».", "“spaced” and «spaced»."],
  ["missing straight closing boundary", " \"first \"second \"third", " \"first \"second \"third"],
  ["missing curly closing boundary", " “first”x “second”x", " “first”x “second”x"],
  ["missing angle closer", " «first «second", " «first «second"],
  ["quote repair after an unfinished line", "\"unfinished\n\" spaced \"", "\"unfinished\n\"spaced\""],
  ["emphasis repair after an unfinished line", "*unfinished\n* spaced *", "*unfinished\n*spaced*"],
  ["CR remains inside a quote line", "\" spaced \r\"", "\"spaced \r\""],
  ["Unicode separator remains inside an emphasis line", "* spaced \u2028*", "*spaced \u2028*"],
  ["each emphasis length", "*** spaced *** ** spaced ** * spaced * ___ spaced ___ __ spaced __ _ spaced _.", "***spaced*** **spaced** *spaced* ___spaced___ __spaced__ _spaced_."],
  ["embedded delimiters stay unchanged", "* first *middle* last * and ** first **middle** last **", "* first *middle* last * and ** first **middle** last **"],
  ["required closing boundaries", " *first *second **third **fourth _fifth _sixth", " *first *second **third **fourth _fifth _sixth"],
  ["fenced content remains protected", "~~~\n\" spaced \" * spaced *\n~~~\n\" spaced \" * spaced *", "~~~\n\" spaced \" * spaced *\n~~~\n\"spaced\" *spaced*"],
])('preserves quote and emphasis handling for %s', (_name, input, expected) => {
  expect(healFormattingArtifacts(input)).toBe(expected)
})

test('leaves repeated unfinished quotes and emphasis unchanged', () => {
  for (const fragment of [' "x', ' “x', ' «x', ' *x', ' **x', ' ***x', ' _x']) {
    const input = fragment.repeat(128)
    expect(healFormattingArtifacts(input)).toBe(input)
  }
})

test('preserves interior whitespace while trimming only spaces and tabs at edges', () => {
  const body = 'a' + ' \t'.repeat(1024) + 'b'
  for (const [open, close] of [['"', '"'], ['“', '”'], ['«', '»'], ['*', '*'], ['**', '**'], ['***', '***'], ['_', '_']]) {
    expect(healFormattingArtifacts(open + body + close)).toBe(open + body + close)
    expect(healFormattingArtifacts(open + ' \t' + body + ' \t' + close)).toBe(open + body + close)
    expect(healFormattingArtifacts(open + '\u00a0' + body + '\u00a0' + close)).toBe(open + '\u00a0' + body + '\u00a0' + close)
  }
})

test.each([
  ["color span closing quote", "<span style=\"color:red\">“Hello</span>”", "<span style=\"color:red\">“Hello”</span>"],
  ["existing inner closing quote", "<span style=\"color:red\">\"Hello\"</span>\"", "<span style=\"color:red\">\"Hello\"</span>\""],
  ["greater-than inside style", "<span style=\"color:red;--x:>\">“Hello</span>”", "<span style=\"color:red;--x:>\">“Hello”</span>"],
  ["mixed style quotes", "<span style=\"color:red'>«Hello</span>»", "<span style=\"color:red'>«Hello»</span>"],
  ["multiple color styles", "<span style=\"color:red\" style=\"color:blue\">“Hello</span>”", "<span style=\"color:red\" style=\"color:blue\">“Hello”</span>"],
  ["crossed style quotes and delimiters", "<span style=\"color:red style='color:blue >\">“Hello</span>”", "<span style=\"color:red style='color:blue >\">“Hello”</span>"],
  ["nested opening prefix", "<span x=<span style=\"color:red\">“Hello</span>”", "<span x=<span style=\"color:red\">“Hello”</span>"],
  ["style word boundary", "<span data-style=\"color:red\">“Hello</span>”", "<span data-style=\"color:red\">“Hello”</span>"],
  ["nonmatching style name", "<span xstyle=\"color:red\">“Hello</span>”", "<span xstyle=\"color:red\">“Hello</span>”"],
  ["non-color style", "<span style=\"font-weight:bold\">“Hello</span>”", "<span style=\"font-weight:bold\">“Hello</span>”"],
  ["style-looking quoted attribute", "<span title=\"style='color:blue'\">“Hello</span>”", "<span title=\"style='color:blue'\">“Hello”</span>"],
  ["case and whitespace", "<SPAN STYLE = \"COLOR \n: red\">«Hello</SPAN>»", "<SPAN STYLE = \"COLOR \n: red\">«Hello»</SPAN>"],
  ["missing quoted closer", "<span style=\"color:red\">“Hello", "<span style=\"color:red\">“Hello"],
  ["multiple repaired spans", "<span style=\"color:red\">“One</span>” <span style=\"color:blue\">«Two</span>»", "<span style=\"color:red\">“One”</span> <span style=\"color:blue\">«Two»</span>"],
])('preserves color span handling for %s', (_name, input, expected) => {
  expect(healFormattingArtifacts(input)).toBe(expected)
})

test('leaves repeated unfinished color spans unchanged', () => {
  const input = '<!--' + '<span style="color:x" '.repeat(32)
  expect(healFormattingArtifacts(input)).toBe(input)
})

test('ignores style-looking text before the first span', () => {
  const prefix = 'style="color:red" '.repeat(64)
  const suffix = 'style="color:green" '.repeat(64)
  expect(healFormattingArtifacts(prefix + '<span style="color:blue">“Hello</span>”' + suffix))
    .toBe(prefix + '<span style="color:blue">“Hello”</span>' + suffix)
})
