export interface STTTranscript {
  text: string
  shouldSend: boolean
}

type Command = 'quoteOpen' | 'quoteClose' | 'singleQuote' | 'apostrophe' | 'thoughtOpen' | 'thoughtClose' | 'asterisk' | 'dash'
type Word = { value: string; start: number; end: number }

const WORD_FORMS: Record<string, string> = {
  quotes: 'quote', starts: 'start', ends: 'end', thoughts: 'thought',
  begins: 'begin', dashes: 'dash', apostrophes: 'apostrophe', asterisks: 'asterisk',
}

const COMMAND_ALIASES: Array<{ command: Command; phrases: string[] }> = [
  { command: 'quoteOpen', phrases: ['quote start', 'open quote', 'start quote', 'begin quote'] },
  { command: 'quoteClose', phrases: ['quote end', 'close quote', 'end quote'] },
  { command: 'singleQuote', phrases: ['single quote'] },
  { command: 'apostrophe', phrases: ['apostrophe'] },
  { command: 'thoughtOpen', phrases: ['thought start', 'begin thought', 'start thought'] },
  { command: 'thoughtClose', phrases: ['thought end', 'end thought'] },
  { command: 'asterisk', phrases: ['asterisk', 'asterix'] },
  { command: 'dash', phrases: ['em dash', 'm dash'] },
]

const ALIASES = COMMAND_ALIASES.flatMap(({ command, phrases }) => phrases.flatMap((phrase) => {
  const words = phrase.split(' ')
  // Some recognizers join command words (for example, "emdash"). Only
  // accept these joined forms exactly; they have no separate anchor word.
  return words.length > 1
    ? [{ command, words, fuzzy: true }, { command, words: [words.join('')], fuzzy: false }]
    : [{ command, words, fuzzy: true }]
})).sort((a, b) => b.words.length - a.words.length)

const COMMAND_SEPARATOR = /^[\s,.;:!?…\-–—]*$/u
const COMMAND_PUNCTUATION = /^[ \t]*[,.;:!?…]+/
const FUZZY_KEYWORDS = new Set(['quote', 'thought', 'dash', 'asterisk', 'asterix', 'apostrophe'])

function tokenize(raw: string): Word[] {
  // Keep contractions and Unicode words intact so a command cannot match
  // inside somebody's name, a possessive, or a word in another language.
  return [...raw.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu)].map((match) => ({
    value: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length,
  }))
}

function isOneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  if (a.length === b.length) {
    return a.slice(index + 1) === b.slice(index + 1)
      || (a[index] === b[index + 1] && a[index + 1] === b[index]
        && a.slice(index + 2) === b.slice(index + 2))
  }
  return a.length > b.length
    ? a.slice(index + 1) === b.slice(index)
    : a.slice(index) === b.slice(index + 1)
}

function matchCommand(raw: string, words: Word[], index: number): { command: Command; length: number } | null {
  let best: { command: Command; length: number; edits: number } | null = null
  let ambiguous = false
  for (const alias of ALIASES) {
    const candidate = words.slice(index, index + alias.words.length)
    if (candidate.length !== alias.words.length) continue
    if (candidate.some((word, i) => i > 0 && !COMMAND_SEPARATOR.test(raw.slice(candidate[i - 1].end, word.start)))) continue

    let edits = 0
    for (let i = 0; i < candidate.length; i++) {
      const actual = WORD_FORMS[candidate[i].value] ?? candidate[i].value
      const expected = alias.words[i]
      if (actual === expected) continue
      // Keep action words exact: "thought stars" must not become "thought
      // start". Also protect the common prose word "quite" from "quote".
      // Standalone punctuation words need at least seven letters for fuzziness.
      const minLength = candidate.length === 1 ? 7 : 4
      if (!alias.fuzzy || !FUZZY_KEYWORDS.has(expected) || actual === 'quite'
        || !/^[a-z]+$/.test(actual) || Math.min(actual.length, expected.length) < minLength
        || !isOneEditApart(actual, expected)) {
        edits = 2
        break
      }
      edits++
    }
    if (edits > 1) continue
    if (!best || candidate.length > best.length || (candidate.length === best.length && edits < best.edits)) {
      best = { command: alias.command, length: candidate.length, edits }
      ambiguous = false
    } else if (candidate.length === best.length && edits === best.edits && best.command !== alias.command) {
      ambiguous = true
    }
  }
  return best && !ambiguous ? { command: best.command, length: best.length } : null
}

function stripSendCommand(raw: string): STTTranscript {
  const words = tokenize(raw)
  const send = words.at(-2)
  const message = words.at(-1)
  // Deliberately no fuzzy matching or singularization for an action that
  // starts generation. Quoted mentions and nonterminal uses remain text.
  if (!send || !message || send.value !== 'send' || message.value !== 'message'
    || !COMMAND_SEPARATOR.test(raw.slice(send.end, message.start))
    || !/^[\s,.;:!?…]*$/.test(raw.slice(message.end))) {
    return { text: raw.trim(), shouldSend: false }
  }
  return { text: raw.slice(0, send.start).replace(/[\s,;:\-–—]+$/, ''), shouldSend: true }
}

/** Parse the whole session, including any interim text, without mutating state. */
export function parseSTTTranscript(raw: string): STTTranscript {
  const { text, shouldSend } = stripSendCommand(raw)
  const words = tokenize(text)
  let output = ''
  let cursor = 0
  let trimNext = false
  const thoughtMarkers: string[] = []
  let singleQuoteOpen = false

  const appendText = (value: string) => {
    output += trimNext ? value.trimStart() : value
    if (value.trim()) trimNext = false
  }
  const open = (marker: string) => { output += marker; trimNext = true }
  const close = (marker: string, punctuation: string) => {
    output = output.trimEnd()
    // A recognizer may put the sentence punctuation on the closing command
    // instead of the prose. Keep it inside the marker, without doubling a
    // sentence ending already present in the content (including nested spans).
    if (punctuation && !/[.!?…][*"'”’)]*$/.test(output)) {
      output = output.replace(/[,;:]+$/, '') + punctuation
    }
    output += marker
    trimNext = false
  }

  for (let index = 0; index < words.length;) {
    const match = matchCommand(text, words, index)
    if (!match) { index++; continue }

    appendText(text.slice(cursor, words[index].start))
    cursor = words[index + match.length - 1].end
    const punctuation = text.slice(cursor).match(COMMAND_PUNCTUATION)?.[0] ?? ''
    cursor += punctuation.length

    switch (match.command) {
      case 'quoteOpen': open('"'); break
      case 'quoteClose': close('"', punctuation.trim()); break
      case 'singleQuote':
        if (singleQuoteOpen) close("'", punctuation.trim())
        else open("'")
        singleQuoteOpen = !singleQuoteOpen
        break
      case 'apostrophe':
        output = output.trimEnd() + "'"
        // Join contraction suffixes, but retain a space in "James' book".
        trimNext = /^(s|t|re|ve|ll|d|m)$/i.test(words[index + match.length]?.value ?? '')
        break
      case 'thoughtOpen': {
        const marker = thoughtMarkers.length > 0 ? '**' : '*'
        open(marker)
        thoughtMarkers.push(marker)
        break
      }
      case 'thoughtClose': close(thoughtMarkers.pop() ?? '*', punctuation.trim()); break
      case 'asterisk':
        // Share emphasis state so an asterisk can close a thought's single
        // marker, and a thought end can close a span opened with an asterisk.
        if (thoughtMarkers.at(-1) === '*') close(thoughtMarkers.pop()!, punctuation.trim())
        else {
          open('*')
          thoughtMarkers.push('*')
        }
        break
      case 'dash':
        output = output.trimEnd() + ' — '
        trimNext = true
        break
    }
    index += match.length
  }
  appendText(text.slice(cursor))
  return { text: output.trim(), shouldSend }
}
