import { WHISTLE_SAMPLE_RATE, type WhistleTranscript, type WhistleWord } from './config'

/** A streaming area resampler. Fractional frames survive render-quantum boundaries. */
export class PcmResampler {
  private readonly ratio: number
  private remaining: number
  private weighted = 0

  constructor(sourceRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error('Invalid microphone sample rate')
    this.ratio = sourceRate / WHISTLE_SAMPLE_RATE
    this.remaining = this.ratio
  }

  push(input: Float32Array, emit: (sample: number) => void): void {
    for (const sample of input) {
      const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
      let available = 1
      while (available > 1e-9) {
        const weight = Math.min(available, this.remaining)
        this.weighted += value * weight
        available -= weight
        this.remaining -= weight
        if (this.remaining < 1e-9) {
          emit(this.weighted / this.ratio)
          this.remaining = this.ratio
          this.weighted = 0
        }
      }
    }
  }

  flush(emit: (sample: number) => void): void {
    const consumed = this.ratio - this.remaining
    if (consumed > 1e-9) emit(this.weighted / consumed)
    this.remaining = this.ratio
    this.weighted = 0
  }
}

export const WHISTLE_WINDOW_SAMPLES = 28 * WHISTLE_SAMPLE_RATE
export const WHISTLE_OVERLAP_SAMPLES = WHISTLE_SAMPLE_RATE

export interface AudioWindow {
  pcm: Float32Array
  offset: number // Absolute sample offset in this recording.
}

/** Bounded capture storage; inference gets independent, transferable windows. */
export class AudioWindowBuffer {
  private buffer = new Float32Array(WHISTLE_WINDOW_SAMPLES)
  private count = 0
  private offset = 0
  private freshSamples = 0

  push(pcm: Float32Array, emit: (window: AudioWindow) => void): void {
    let read = 0
    while (read < pcm.length) {
      const count = Math.min(pcm.length - read, this.buffer.length - this.count)
      this.buffer.set(pcm.subarray(read, read + count), this.count)
      this.count += count
      this.freshSamples += count
      read += count
      if (this.count === this.buffer.length) {
        emit({ pcm: this.buffer.slice(), offset: this.offset })
        this.buffer.copyWithin(0, this.count - WHISTLE_OVERLAP_SAMPLES)
        this.offset += this.count - WHISTLE_OVERLAP_SAMPLES
        this.count = WHISTLE_OVERLAP_SAMPLES
        this.freshSamples = 0
      }
    }
  }

  finish(): AudioWindow | null {
    if (!this.freshSamples) return null // The retained overlap was already transcribed.
    const window = { pcm: this.buffer.slice(0, this.count), offset: this.offset }
    this.count = this.freshSamples = 0
    return window
  }
}

/** Join at the center of the overlap, where both windows had intact word context. */
export class TranscriptAssembler {
  private words: WhistleWord[] = []

  append(result: WhistleTranscript, offset: number): void {
    if (!result.words.length) return
    const seconds = offset / WHISTLE_SAMPLE_RATE
    const seam = seconds + WHISTLE_OVERLAP_SAMPLES / WHISTLE_SAMPLE_RATE / 2
    const midpoint = (word: WhistleWord) => (word.start + word.end) / 2
    const incoming = result.words.map((word) => ({ ...word, start: word.start + seconds, end: word.end + seconds }))
    if (offset > 0) {
      // Attention timestamps can drift around the seam. Anchor shared words in
      // the overlap before falling back to a time cut, preserving real repeats.
      const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      let anchor: { left: number; right: number; count: number; drift: number } | null = null
      for (let left = this.words.length - 1; left >= 0; left--) {
        if (midpoint(this.words[left]) < seconds - 0.5) break
        for (let right = 0; right < incoming.length && midpoint(incoming[right]) <= seconds + 1.5; right++) {
          let count = 0
          let drift = 0
          while (this.words[left + count] && incoming[right + count]) {
            const previous = this.words[left + count]
            const next = incoming[right + count]
            const word = normalize(previous.word)
            const distance = Math.abs(midpoint(previous) - midpoint(next))
            if (!word || word !== normalize(next.word) || distance > 0.8) break
            drift += distance
            count++
          }
          if (count && (!anchor || count > anchor.count || (count === anchor.count && drift < anchor.drift))) {
            anchor = { left, right, count, drift }
          }
        }
      }
      if (anchor) {
        this.words = [...this.words.slice(0, anchor.left + anchor.count), ...incoming.slice(anchor.right + anchor.count)]
        return
      }
      this.words = this.words.filter((word) => midpoint(word) < seam)
    }
    this.words.push(...incoming.filter((word) => offset === 0 || midpoint(word) >= seam))
  }

  text(): string {
    return this.words.map((word) => word.word).join(' ').trim()
  }

  /** Assembled words with times from the start of the recording. */
  wordList(): WhistleWord[] {
    return this.words.map((word) => ({ ...word }))
  }
}

/** Mirrors the connection recorder's speech confirmation and 1.6-second silence threshold. */
export class SpeechActivityDetector {
  private elapsedMs = 0
  private speechMs = 0
  private lastSpeechMs = 0
  private noiseFloor = 0.006
  private confirmed = false

  push(pcm: Float32Array): boolean {
    const deltaMs = pcm.length / WHISTLE_SAMPLE_RATE * 1000
    this.elapsedMs += deltaMs
    let sum = 0
    for (const sample of pcm) sum += sample * sample
    const rms = Math.sqrt(sum / Math.max(1, pcm.length))
    if (rms >= Math.max(0.012, this.noiseFloor * 3)) {
      this.speechMs += deltaMs
      this.lastSpeechMs = this.elapsedMs
      if (this.speechMs >= 140) this.confirmed = true
    } else if (!this.confirmed) {
      this.speechMs = Math.max(0, this.speechMs - deltaMs)
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05
    }
    return this.confirmed && this.elapsedMs >= 900 && this.elapsedMs - this.lastSpeechMs >= 1600
  }
}
