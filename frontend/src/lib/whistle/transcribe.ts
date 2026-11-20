import { AudioWindowBuffer, PcmResampler, TranscriptAssembler } from './audio'
import { WHISTLE_SAMPLE_RATE, type WhistleWord } from './config'
import type { WhistleClient } from './client'
import type { SpindleSTTPcmAudio } from 'lumiverse-spindle-types'

export const WHISTLE_MAX_AUDIO_SECONDS = 600
export const WHISTLE_MAX_AUDIO_BYTES = 64 * 1024 * 1024

const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Transcription cancelled', 'AbortError')
}

async function decode(audio: Blob, signal?: AbortSignal): Promise<AudioBuffer> {
  if (!audio.size || audio.size > WHISTLE_MAX_AUDIO_BYTES) throw new Error('Whistle audio must be between 1 byte and 64 MiB')
  const Context = window.AudioContext || (window as any).webkitAudioContext
  if (!Context) throw new Error('Audio decoding is unavailable; supply mono PCM instead')
  const context: AudioContext = new Context()
  try {
    const bytes = await audio.arrayBuffer()
    checkAbort(signal)
    const buffer = await context.decodeAudioData(bytes)
    checkAbort(signal)
    return buffer
  } finally { await context.close().catch(() => {}) }
}

/** Sequential bounded windows reuse the same client/model as chat microphone capture. */
export async function transcribeWhistleAudio(
  audio: Blob | SpindleSTTPcmAudio,
  language: string | undefined,
  client: Pick<WhistleClient, 'retain' | 'prepare' | 'transcribe'>,
  signal?: AbortSignal,
  keywords?: readonly string[],
): Promise<{ text: string; language?: string; words: WhistleWord[] }> {
  checkAbort(signal)
  let channels: Float32Array[]
  let sampleRate: number
  if (audio instanceof Blob) {
    const decoded = await decode(audio, signal)
    if (decoded.duration > WHISTLE_MAX_AUDIO_SECONDS) throw new Error('Whistle audio exceeds the ten-minute limit')
    channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
    sampleRate = decoded.sampleRate
  } else {
    if (!audio || !(audio.samples instanceof Float32Array)) throw new Error('Whistle requires an audio Blob or Float32Array PCM')
    channels = [audio.samples]
    sampleRate = audio.sampleRate
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Audio sample rate must be between 8000 and 192000 Hz')
  if (!channels.length || !channels[0].length) throw new Error('Audio is empty')
  if (channels[0].length / sampleRate > WHISTLE_MAX_AUDIO_SECONDS) throw new Error('Whistle audio exceeds the ten-minute limit')
  checkAbort(signal)
  const release = client.retain()
  try {
    await client.prepare()
    checkAbort(signal)
    const resampler = new PcmResampler(sampleRate)
    const windows = new AudioWindowBuffer()
    const transcript = new TranscriptAssembler()
    let detectedLanguage = language
    const infer = async (window: { pcm: Float32Array; offset: number }) => {
      checkAbort(signal)
      const result = await client.transcribe(window.pcm, language, signal, keywords)
      checkAbort(signal)
      transcript.append(result, window.offset)
      if (result.language) detectedLanguage = result.language
    }
    for (let offset = 0; offset < channels[0].length; offset += 4096) {
      checkAbort(signal)
      const count = Math.min(4096, channels[0].length - offset)
      const mono = new Float32Array(count)
      for (const channel of channels) {
        for (let index = 0; index < count; index++) mono[index] += channel[offset + index] / channels.length
      }
      const output = new Float32Array(Math.ceil(count * WHISTLE_SAMPLE_RATE / sampleRate) + 1)
      let written = 0
      resampler.push(mono, (sample) => { output[written++] = sample })
      const pending: Array<{ pcm: Float32Array; offset: number }> = []
      windows.push(output.subarray(0, written), (window) => pending.push(window))
      for (const window of pending) await infer(window)
    }
    const remaining: number[] = []
    resampler.flush((sample) => remaining.push(sample))
    const pending: Array<{ pcm: Float32Array; offset: number }> = []
    windows.push(new Float32Array(remaining), (window) => pending.push(window))
    const tail = windows.finish()
    if (tail) pending.push(tail)
    for (const window of pending) await infer(window)
    return { text: transcript.text(), language: detectedLanguage, words: transcript.wordList() }
  } finally { release() }
}
