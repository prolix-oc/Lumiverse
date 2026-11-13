import { describe, expect, test } from 'bun:test'
import { transcribeWhistleAudio } from './transcribe'
import { WHISTLE_SAMPLE_RATE } from './config'

function client() {
  const windows: Float32Array[] = []
  const keywords: Array<readonly string[] | undefined> = []
  let leases = 0
  return {
    windows, keywords, leases: () => leases,
    retain() { leases++; return () => { leases-- } },
    async prepare() {},
    async transcribe(pcm: Float32Array, _language?: string, _signal?: AbortSignal, words?: readonly string[]) {
      windows.push(pcm)
      keywords.push(words)
      const word = `window${windows.length}`
      return { text: word, language: 'en', words: [{ word, start: 0.6, end: 1, probability: 1 }] }
    },
  }
}

describe('Whistle supplied audio', () => {
  test('resamples PCM without mutating or detaching caller data', async () => {
    const c = client(); const samples = new Float32Array(48000).fill(0.25)
    const result = await transcribeWhistleAudio({ samples, sampleRate: 48000 }, 'en', c)
    expect(c.windows).toHaveLength(1)
    expect(c.windows[0].length).toBe(WHISTLE_SAMPLE_RATE)
    expect(c.windows[0][123]).toBeCloseTo(0.25)
    expect(samples.length).toBe(48000); expect(samples[0]).toBe(0.25)
    expect(result).toEqual({ text: 'window1', language: 'en', words: [{ word: 'window1', start: 0.6, end: 1, probability: 1 }] })
    expect(c.leases()).toBe(0)
  })

  test('long audio uses bounded overlapping windows and serial inference', async () => {
    const c = client()
    const result = await transcribeWhistleAudio({ samples: new Float32Array(56 * WHISTLE_SAMPLE_RATE), sampleRate: WHISTLE_SAMPLE_RATE }, 'en', c)
    expect(c.windows.map((window) => window.length)).toEqual([28 * WHISTLE_SAMPLE_RATE, 28 * WHISTLE_SAMPLE_RATE, 2 * WHISTLE_SAMPLE_RATE])
    expect(result.text).toBe('window1 window2 window3')
    expect(c.leases()).toBe(0)
  })

  test('passes keywords to every window and returns words on the recording timeline', async () => {
    const c = client()
    const result = await transcribeWhistleAudio({ samples: new Float32Array(56 * WHISTLE_SAMPLE_RATE), sampleRate: WHISTLE_SAMPLE_RATE }, 'en', c, undefined, ['Lumi'])
    expect(c.keywords).toEqual([['Lumi'], ['Lumi'], ['Lumi']])
    expect(result.words.map(({ word, start }) => [word, start])).toEqual([['window1', 0.6], ['window2', 27.6], ['window3', 54.6]])
  })

  test('invalid, empty, and oversized PCM never initializes the model', async () => {
    const c = client()
    await expect(transcribeWhistleAudio({ samples: new Float32Array(1), sampleRate: 0 }, 'en', c)).rejects.toThrow('sample rate')
    await expect(transcribeWhistleAudio({ samples: new Float32Array(), sampleRate: 16000 }, 'en', c)).rejects.toThrow('empty')
    await expect(transcribeWhistleAudio({ samples: new Float32Array(600 * 8000 + 1), sampleRate: 8000 }, 'en', c)).rejects.toThrow('ten-minute')
    expect(c.windows).toHaveLength(0); expect(c.leases()).toBe(0)
  })

  test('abort after one window prevents remaining inference and releases the lease', async () => {
    const c = client(); const abort = new AbortController()
    const original = c.transcribe
    c.transcribe = async (pcm) => { const result = await original(pcm); abort.abort(); return result }
    await expect(transcribeWhistleAudio({ samples: new Float32Array(56 * WHISTLE_SAMPLE_RATE), sampleRate: WHISTLE_SAMPLE_RATE }, 'en', c, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(c.windows).toHaveLength(1); expect(c.leases()).toBe(0)
  })
})
