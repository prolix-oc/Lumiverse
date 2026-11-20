import { describe, expect, test } from 'bun:test'
import type { SpeechDetectionRules } from '@/types/store'
import { getSpokenText, parseSegments, sanitizeForTts } from './speechDetection'

const rules: SpeechDetectionRules = {
  asterisked: 'skip', quoted: 'speech', undecorated: 'narration',
}
const preserveCues = { preserveAudioCues: true }

describe('TTS sanitization', () => {
  test('keeps the reported giggle and all dialogue following it', () => {
    const text = "because reasons, don't worry about it. You kept trying to tip me. Like a delivery guy. <giggle> And then we kept talking."
    expect(sanitizeForTts(text, preserveCues)).toBe(text)
  })

  test.each(['<emotion>', '<sound>', '<new-performance-cue-2042>', '<an entirely new vocal cue>', '<short pause>', '<GIGGLE>', '<giggle/>'])('preserves standalone %s without a cue name catalog', (cue) => {
    expect(sanitizeForTts(`Before ${cue} after.`, preserveCues)).toBe(`Before ${cue} after.`)
  })

  test('removes cues for plain TTS without truncating the rest', () => {
    expect(sanitizeForTts('Before <new vocal cue> after <giggle/> the cue.')).toBe('Before after the cue.')
    expect(getSpokenText('"Before <giggle> after."', rules)).toBe('Before after.')
  })

  test('keeps closing dialogue quotes so the final sentence remains speech', () => {
    const cleaned = sanitizeForTts('"First sentence." "Like a delivery guy. <giggle> Still talking."', preserveCues)
    expect(parseSegments(cleaned, rules)).toEqual([{
      text: 'First sentence. Like a delivery guy. <giggle> Still talking.',
      type: 'quoted', action: 'speech',
    }])
  })

  test('strips structural HTML and nested font/span markup while retaining prose and cues', () => {
    const text = '<section><div class="card"><font color="red" face="serif"><span style="color: blue">"Before <brand new cue> after."</span></font></div></section>'
    expect(sanitizeForTts(text, preserveCues)).toBe('"Before <brand new cue> after."')
    expect(sanitizeForTts(text)).toBe('"Before after."')
  })

  test('strips font/span attributes containing angle brackets without altering dialogue', () => {
    const text = '<font title="a > b"><span data-note=\'c > d\'>"Before <new cue> after."</span></font>'
    expect(sanitizeForTts(text, preserveCues)).toBe('"Before <new cue> after."')
    expect(parseSegments(sanitizeForTts(text, preserveCues), rules)[0].action).toBe('speech')
  })

  test('filters HTML void elements without treating their attributes as cues', () => {
    const text = 'Before <img src="photo.png"><input disabled><br><hr/><link rel="stylesheet" href="style.css"> after.'
    expect(sanitizeForTts(text, preserveCues)).toBe('Before after.')
  })

  test('removes comments, doctypes, and non-prose HTML blocks', () => {
    const text = '<!DOCTYPE html>Before <!-- hidden --> <script>hidden()</script><style>.hidden {}</style><details><summary>Stats</summary>Hidden tracker</details> after.'
    expect(sanitizeForTts(text, preserveCues)).toBe('Before after.')
  })

  test('removes custom paired metadata even when it contains cues or prose HTML', () => {
    const text = '<div>Before <custom-state><span>Hidden <giggle></span></custom-state> <tracker><font color="red">Secret</font></tracker> after <new cue>.</div>'
    expect(sanitizeForTts(text, preserveCues)).toBe('Before after <new cue>.')
  })

  test('removes all contents when custom metadata nests the same tag', () => {
    const text = 'Before <custom-state>Hidden <custom-state>Nested <giggle></custom-state> Still hidden</custom-state> after.'
    expect(sanitizeForTts(text, preserveCues)).toBe('Before after.')
  })

  test.each(['thinking', 'reasoning', 'tracker', 'status', 'loom_sum', 'tool_call', 'script'])('still drops unfinished %s blocks', (tag) => {
    expect(sanitizeForTts(`Before <giggle> visible. <${tag}>Hidden trailing content`, preserveCues)).toBe('Before <giggle> visible.')
  })

  test('filters self-closing and stray closing metadata markers', () => {
    expect(sanitizeForTts('Before <tracker/> </thinking> after <giggle>.', preserveCues)).toBe('Before after <giggle>.')
  })

  test('still filters code and images and keeps link labels and decoded entities', () => {
    const text = 'Before `<giggle>` ```<new cue>``` ![photo](photo.png) [hello](https://example.com) &amp; after <giggle>.'
    expect(sanitizeForTts(text, preserveCues)).toBe('Before hello & after <giggle>.')
  })
})

describe('Fish Audio directions and parsing', () => {
  const drama = { fishModel: 'drama-3-preview' }

  test('preserves Drama delivery/language spans and unwraps them for other voices', () => {
    const text = 'Before <whisper>keep <emphasis>these words</emphasis></whisper> <french>Bonjour</french> after.'
    expect(sanitizeForTts(text, drama)).toBe(text)
    expect(sanitizeForTts(text)).toBe('Before keep these words Bonjour after.')
    expect(sanitizeForTts(text, { fishModel: 's2.1-pro' })).toBe('Before keep these words Bonjour after.')
  })

  test('metadata inside and around Drama spans is still removed', () => {
    expect(sanitizeForTts('<tracker><whisper>Hidden</whisper></tracker> <whisper>Visible <thinking>Secret</thinking> words.</whisper>', drama))
      .toBe('<whisper>Visible words.</whisper>')
    expect(sanitizeForTts('<whisper>Visible.</whisper> <thinking><whisper>Hidden', drama)).toBe('<whisper>Visible.</whisper>')
  })

  test('directions containing quotes/asterisks stay attached to quoted speech', () => {
    const text = 'Narration. [say "hello", *very* softly] "Hello there."'
    expect(parseSegments(sanitizeForTts(text, drama), rules, drama)).toEqual([
      { text: 'Narration.', type: 'undecorated', action: 'narration' },
      { text: '[say "hello", *very* softly] Hello there.', type: 'quoted', action: 'speech' },
    ])
  })

  test('balances paired instructions independently across voice boundaries', () => {
    const text = '<whisper>"Hello." Narration. "<emphasis>Again.</emphasis>"</whisper>'
    expect(parseSegments(sanitizeForTts(text, drama), rules, drama)).toEqual([
      { text: '<whisper>Hello.</whisper>', type: 'quoted', action: 'speech' },
      { text: '<whisper>Narration.</whisper>', type: 'undecorated', action: 'narration' },
      { text: '<whisper><emphasis>Again.</emphasis></whisper>', type: 'quoted', action: 'speech' },
    ])
  })

  test('directions preceding skipped text carry forward to the next spoken span', () => {
    expect(parseSegments('[gentle] *Hidden stage direction.* "Hello."', rules, drama).filter((segment) => segment.action !== 'skip'))
      .toEqual([{ text: '[gentle] Hello.', type: 'quoted', action: 'speech' }])
  })

  test('retains Fish phoneme/speaker markers without exposing them to other providers', () => {
    const text = '<|speaker:0|>"An <|phoneme_start|>EH1 N JH AH0 N IH0 R<|phoneme_end|>."'
    expect(parseSegments(sanitizeForTts(text, drama), rules, drama)[0].text).toBe('<|speaker:0|> An <|phoneme_start|>EH1 N JH AH0 N IH0 R<|phoneme_end|>.')
    expect(sanitizeForTts(text)).toBe('"An EH1 N JH AH0 N IH0 R ."')
  })

  test('strips Fish directions only when converting a mixed-provider segment', () => {
    expect(sanitizeForTts('[warm] <whisper>Visible words.</whisper>', { stripFishDirections: true })).toBe('Visible words.')
    expect(sanitizeForTts('[warm] Visible words.', { fishModel: 's2-pro', stripFishDirections: true })).toBe('[warm] Visible words.')
    expect(sanitizeForTts('Visible [ordinary annotation].')).toBe('Visible [ordinary annotation].')
  })
})
