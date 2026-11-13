import { describe, expect, test } from 'bun:test'
import { parseSTTTranscript } from './sttCommands'

describe('dictation formatting commands', () => {
  test.each([
    ['quote start Hello quote end', '"Hello"'],
    ['Open quotes, Hello there! Close quotes.', '"Hello there!"'],
    ['She says open quote hello close quote and leaves.', 'She says "hello" and leaves.'],
    ['start quote hello end quote', '"hello"'],
    ['begin quote hello quote end', '"hello"'],
    ['single quote hello single quote', "'hello'"],
    ['It apostrophe s James apostrophe book.', "It's James' book."],
    ['I apostrophe m sure we apostrophe re ready.', "I'm sure we're ready."],
    ['thought start I should be careful thought end', '*I should be careful*'],
    ['Thoughts start. I should be careful. Thoughts end.', '*I should be careful.*'],
    ['begin thought outer thought start inner thought end outer end thought', '*outer **inner** outer*'],
    ['thought start thought start nested thought end thought end', '***nested***'],
    ['thought start. Maybe, thought end. She leaves.', '*Maybe.* She leaves.'],
    ['open quote Hello close quote. She leaves.', '"Hello." She leaves.'],
    ['She says open quote Hello, close quote and leaves.', 'She says "Hello," and leaves.'],
    ['open quote Really? close quote. Yes.', '"Really?" Yes.'],
    ['asterisk I wait asterisk. Open quote Hello close quote.', '*I wait.* "Hello."'],
    ['thought start I whisper open quote Hello close quote. thought end.', '*I whisper "Hello."*'],
    ['asterisk hello asterisk', '*hello*'],
    ['thought start I wait asterisk', '*I wait*'],
    ['asterisk I wait thought end', '*I wait*'],
    ['asterisk outer thought start inner thought end outer asterisk', '*outer **inner** outer*'],
    ['one em dash two', 'one — two'],
    ['one M-dash two', 'one — two'],
    ['one emdash two', 'one — two'],
    ['quote-start Hello quote-end', '"Hello"'],
    ['quote, start: Hello quote, end.', '"Hello."'],
    ['thoughtstart hello thoughtend', '*hello*'],
  ])('normalizes %j', (raw, expected) => {
    expect(parseSTTTranscript(raw)).toEqual({ text: expected, shouldSend: false })
  })

  test.each([
    ['qoute start Hello qoute end', '"Hello"'],
    ['open qote Hello close qote', '"Hello"'],
    ['thougt start Hello thougt end', '*Hello*'],
    ['though start Hello though end', '*Hello*'],
    ['asterick Hello asterick', '*Hello*'],
    ['asterix Hello asterix', '*Hello*'],
    ['one em dahs two', 'one — two'],
  ])('matches a conservative STT variation in %j', (raw, expected) => {
    expect(parseSTTTranscript(raw).text).toBe(expected)
  })

  test.each([
    'The quote started yesterday and the thought ended today.',
    'We are close quite often.',
    'She taught art and fought hard.',
    'a single quite ordinary day',
    'I thought stars were beautiful.',
    'I thought smart people knew that.',
    'thought strt and thought starr',
    'an asteroid and a catastrophe',
    'qoute strt has two errors',
    'thought and action',
    'in dash mode',
    "quote's start and thought's end",
    'équote start and thought endé',
    'quote / start and thought 💭 end',
    'quote (start) and thought [end]',
    'keep   these spaces\nand this line.  Really?!',
  ])('preserves noncommands in %j', (raw) => {
    expect(parseSTTTranscript(raw)).toEqual({ text: raw, shouldSend: false })
  })

  test('does not rewrite punctuation elsewhere when applying a command', () => {
    expect(parseSTTTranscript('Wait...  Really?!\n\nopen quote yes close quote').text)
      .toBe('Wait...  Really?!\n\n"yes"')
  })

  test('reparsing an interim hypothesis does not change thought nesting', () => {
    const raw = 'thought start outer thought start'
    expect(parseSTTTranscript(`${raw} maybe`).text).toBe('*outer **maybe')
    expect(parseSTTTranscript(`${raw} inner thought end outer thought end`).text)
      .toBe('*outer **inner** outer*')
    expect(parseSTTTranscript('thought start new session thought end').text).toBe('*new session*')
  })
})

describe('dictation send command', () => {
  test.each([
    ['Hello send message', 'Hello'],
    ['Hello. Send message.', 'Hello.'],
    ['Hello! SEND MESSAGE!', 'Hello!'],
    ['Hello, send message...', 'Hello'],
    ['Hello send, message.', 'Hello'],
    ['send message.', ''],
    ['thought start Hello thought end send message.', '*Hello*'],
  ])('sends only for a terminal exact command in %j', (raw, expected) => {
    expect(parseSTTTranscript(raw)).toEqual({ text: expected, shouldSend: true })
  })

  test.each([
    'Hello send massage.', 'Hello sent message.', 'Hello send messages.',
    'Hello resend message', 'Hello sendmessage', 'Hello send message later.',
    'Hello send message. One more thing.', 'She said "send message".',
    'send / message', 'send (message)',
  ])('does not start generation for %j', (raw) => {
    expect(parseSTTTranscript(raw)).toEqual({ text: raw, shouldSend: false })
  })

  test('keeps a quoted command literal', () => {
    expect(parseSTTTranscript('open quote send message close quote.'))
      .toEqual({ text: '"send message."', shouldSend: false })
  })

  test('handles blank transcripts', () => {
    expect(parseSTTTranscript(' \n ')).toEqual({ text: '', shouldSend: false })
  })
})
