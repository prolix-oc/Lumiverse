import { describe, expect, test } from 'bun:test'
import { AudioWindowBuffer, PcmResampler, SpeechActivityDetector, TranscriptAssembler, WHISTLE_WINDOW_SAMPLES } from './audio'
import { whistleLanguage, type WhistleTranscript } from './config'

describe('Whistle audio', () => {
  for (const rate of [16000, 44100, 48000]) {
    test(`resamples ${rate} Hz across arbitrary microphone frame boundaries`, () => {
      const input = Float32Array.from({ length: rate }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 1000 * i / rate))
      const whole: number[] = []
      const streamed: number[] = []
      const direct = new PcmResampler(rate)
      direct.push(input, (value) => whole.push(value))
      direct.flush((value) => whole.push(value))
      const resampler = new PcmResampler(rate)
      for (let i = 0; i < input.length; i += 128) resampler.push(input.subarray(i, i + 128), (value) => streamed.push(value))
      resampler.flush((value) => streamed.push(value))
      expect(streamed).toEqual(whole)
      expect(Math.abs(streamed.length - 16000)).toBeLessThanOrEqual(1)
      let crossings = 0
      for (let i = 1; i < streamed.length; i++) if (streamed[i - 1] < 0 && streamed[i] >= 0) crossings++
      expect(Math.abs(crossings - 1000)).toBeLessThanOrEqual(1)
      expect(Math.max(...streamed)).toBeGreaterThan(0.35)
    })
  }

  test('preserves all 61 seconds of audio with bounded overlapping windows', () => {
    const input = Float32Array.from({ length: 61 * 16000 }, (_, i) => i)
    const buffer = new AudioWindowBuffer()
    const windows: ReturnType<AudioWindowBuffer['finish']>[] = []
    for (let i = 0; i < input.length; i += 1600) buffer.push(input.subarray(i, i + 1600), (window) => windows.push(window))
    windows.push(buffer.finish())
    expect(windows.map((window) => window?.offset)).toEqual([0, 27 * 16000, 54 * 16000])
    for (const window of windows) {
      expect(window!.pcm.length).toBeLessThanOrEqual(WHISTLE_WINDOW_SAMPLES)
      expect(window!.pcm[0]).toBe(window!.offset)
      expect(window!.pcm.at(-1)).toBe(window!.offset + window!.pcm.length - 1)
    }
    expect(windows.at(-1)!.offset + windows.at(-1)!.pcm.length).toBe(input.length)
    expect(buffer.finish()).toBeNull()
  })

  test('does not transcribe a retained overlap twice at an exact window boundary', () => {
    const buffer = new AudioWindowBuffer()
    let emitted = 0
    buffer.push(new Float32Array(WHISTLE_WINDOW_SAMPLES), () => emitted++)
    expect(emitted).toBe(1)
    expect(buffer.finish()).toBeNull()
  })

  test('joins a command across overlapping windows without deleting repeated words elsewhere', () => {
    const assembler = new TranscriptAssembler()
    const result = (words: Array<[string, number, number]>): WhistleTranscript => ({
      text: words.map(([word]) => word).join(' '), language: 'en',
      words: words.map(([word, start, end]) => ({ word, start, end, probability: 1 })),
    })
    assembler.append(result([['very', 1, 1.2], ['very', 1.3, 1.5], ['send', 26.8, 27.2], ['message', 27.3, 27.9]]), 0)
    assembler.append(result([['send', 0, 0.2], ['message', 0.4, 0.9]]), 27 * 16000)
    expect(assembler.text()).toBe('very very send message')
    assembler.append({ text: '', language: '', words: [] }, 54 * 16000)
    expect(assembler.text()).toBe('very very send message')
  })

  test('requires confirmed speech before stopping after a sustained pause', () => {
    const detector = new SpeechActivityDetector()
    const silence = new Float32Array(1600)
    for (let i = 0; i < 20; i++) expect(detector.push(silence)).toBe(false)
    expect(detector.push(new Float32Array(1600).fill(0.2))).toBe(false)
    expect(detector.push(new Float32Array(1600).fill(0.2))).toBe(false)
    for (let i = 0; i < 15; i++) expect(detector.push(silence)).toBe(false)
    expect(detector.push(silence)).toBe(true)
  })

  test('stitches matching words when attention timestamps drift across the overlap seam', () => {
    const assembler = new TranscriptAssembler()
    assembler.append({ text: 'ask what', language: 'en', words: [
      { word: 'ask', start: 26.2, end: 26.6, probability: 1 },
      { word: 'what', start: 27, end: 27.6, probability: 1 },
    ] }, 0)
    assembler.append({ text: 'What your country', language: 'en', words: [
      { word: 'What', start: 0.6, end: 1, probability: 1 },
      { word: 'your', start: 1, end: 1.3, probability: 1 },
      { word: 'country', start: 1.3, end: 1.8, probability: 1 },
    ] }, 27 * 16000)
    expect(assembler.text()).toBe('ask what your country')
  })

  test('maps supported browser locales and falls back to detection for other languages', () => {
    expect(whistleLanguage('en-US')).toBe('en')
    expect(whistleLanguage('nl-NL')).toBe('nl')
    expect(whistleLanguage('PL_pl')).toBe('pl')
    expect(whistleLanguage('ja-JP')).toBeUndefined()
    expect(whistleLanguage('auto')).toBeUndefined()
  })
})
