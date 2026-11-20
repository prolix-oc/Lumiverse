import captureWorkletUrl from './capture.worklet.ts?worker&url'
import type { STTAudioFrame, STTConfig, STTEngine, STTEngineStatus, STTResult } from '../sttEngine'
import { AudioWindowBuffer, PcmResampler, SpeechActivityDetector, TranscriptAssembler, type AudioWindow } from './audio'
import { getWhistleUnavailableReason, whistleLanguage } from './config'
import { whistleClient, type WhistleClient } from './client'
import { scheduleMicrotask } from '../schedule-microtask'

export class WhistleSTTEngine implements STTEngine {
  private resultCb: ((result: STTResult) => void) | null = null
  private errorCb: ((error: Error) => void) | null = null
  private stopCb: (() => void) | null = null
  private audioFrameCb: ((frame: STTAudioFrame) => void) | null = null
  private statusCb: ((status: STTEngineStatus) => void) | null = null
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private fallbackCapture: ScriptProcessorNode | null = null
  private fallbackResampler: PcmResampler | null = null
  private fallbackFrame = new Float32Array(1600)
  private fallbackCount = 0
  private analyser: AnalyserNode | null = null
  private mute: GainNode | null = null
  private listening = false
  private starting = false
  private destroyed = false
  private stopping = false
  private finishing = false
  private stopNotified = false
  private abort = new AbortController()
  private unsubscribe: (() => void) | null = null
  private release: (() => void) | null = null
  private preparation: Promise<void> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private windows = new AudioWindowBuffer()
  private activity = new SpeechActivityDetector()
  private transcript = new TranscriptAssembler()
  private queue = Promise.resolve()
  private pendingWindows = 0

  constructor(private config: STTConfig, private client: WhistleClient = whistleClient) {}

  async start(): Promise<void> {
    if (this.destroyed || this.starting || this.listening) return
    const unavailable = getWhistleUnavailableReason()
    if (unavailable) throw new Error('Whistle is unavailable. Check Voice & Speech settings for details.')
    this.starting = true
    this.release = this.client.retain()
    this.unsubscribe = this.client.subscribe(() => {
      const state = this.client.getState()
      if (this.starting && !this.stopping && !this.destroyed && state.phase === 'loading') {
        this.statusCb?.({ phase: 'loading', progress: state.progress })
      }
    })
    try {
      // Resume in the microphone button's user gesture, before any download awaits.
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      this.context = new AudioContextClass()
      const context = this.context!
      const resumed = context.resume()
      // Model preparation must not delay microphone capture. Inference waits
      // for it later; the existing bounded window queue preserves early speech.
      this.preparation = this.client.prepare()
      void this.preparation.catch((error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
      const canUseFallback = typeof context.createScriptProcessor === 'function'
      let workletReady = false
      let workletError: unknown
      let worklet = Promise.resolve()
      if (typeof AudioWorkletNode !== 'undefined' && context.audioWorklet) {
        try {
          worklet = context.audioWorklet.addModule(captureWorkletUrl).then(
            () => { workletReady = true },
            (error) => { workletError = error },
          )
        } catch (error) { workletError = error }
      }
      const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
        .then((stream) => {
          if (this.destroyed || this.stopping || this.abort.signal.aborted) stream.getTracks().forEach((track) => track.stop())
          else this.stream = stream
        })
      // Worklet loading overlaps permission/device startup. If it is still
      // loading when the microphone is ready, capture through the fallback.
      await this.waitFor(Promise.all([resumed, microphone, ...(canUseFallback ? [] : [worklet])]))
      if (this.destroyed || this.stopping || this.abort.signal.aborted) { this.cleanup(); this.notifyStop(); return }
      if (workletReady) {
        try {
          this.capture = new AudioWorkletNode(context, 'lumiverse-whistle-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount: 1, channelCountMode: 'explicit',
          })
        } catch (error) {
          if (!canUseFallback) throw error
        }
      }
      if (this.capture) {
        this.capture.port.onmessage = ({ data }) => {
          if (this.destroyed) return
          if (data.type === 'stopped') { void this.finish(); return }
          if (data.type === 'audio' && data.pcm instanceof Float32Array) this.acceptAudio(data.pcm)
        }
        this.capture.onprocessorerror = () => this.fail(new Error('The microphone stopped recording. Please try again.'))
      } else {
        if (!canUseFallback) throw workletError || new Error('The microphone audio processor is unavailable. Please try again.')
        this.fallbackResampler = new PcmResampler(context.sampleRate)
        this.fallbackCapture = context.createScriptProcessor(4096, 1, 1)
        this.fallbackCapture.onaudioprocess = ({ inputBuffer }) => {
          if (this.listening && !this.stopping && !this.destroyed) {
            this.fallbackResampler!.push(inputBuffer.getChannelData(0), this.acceptFallbackSample)
          }
        }
      }
      this.source = this.context!.createMediaStreamSource(this.stream!)
      this.analyser = this.context!.createAnalyser()
      this.analyser.fftSize = 1024
      this.mute = this.context!.createGain()
      this.mute.gain.value = 0
      this.source.connect(this.analyser)
      const capture = this.capture || this.fallbackCapture!
      this.source.connect(capture)
      capture.connect(this.mute)
      this.mute.connect(this.context!.destination)
      for (const track of this.stream!.getAudioTracks()) {
        track.onended = () => { if (this.listening) this.stop() }
      }
      this.starting = false
      this.listening = true
      this.statusCb?.({ phase: 'listening' })
    } catch (error) {
      if (this.destroyed || this.stopping) { this.cleanup(); this.notifyStop(); return }
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Cancellation settles local waits without cancelling the shared model download. */
  private async waitFor(promise: Promise<unknown>): Promise<void> {
    let cancel!: () => void
    const cancelled = new Promise<void>((resolve) => {
      cancel = () => resolve()
      if (this.abort.signal.aborted) resolve()
      else this.abort.signal.addEventListener('abort', cancel, { once: true })
    })
    try { await Promise.race([promise, cancelled]) }
    finally { this.abort.signal.removeEventListener('abort', cancel) }
  }

  private acceptFallbackSample = (sample: number): void => {
    this.fallbackFrame[this.fallbackCount++] = sample
    if (this.fallbackCount === this.fallbackFrame.length) this.flushFallbackFrame()
  }

  private flushFallbackFrame(): void {
    if (!this.fallbackCount) return
    const pcm = this.fallbackFrame.slice(0, this.fallbackCount)
    this.fallbackCount = 0
    if (!this.abort.signal.aborted) this.acceptAudio(pcm)
  }

  private acceptAudio(pcm: Float32Array): void {
    this.windows.push(pcm, (window) => this.enqueue(window))
    let sum = 0
    let peak = 0
    for (const sample of pcm) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)) }
    const frequencies: number[] = []
    if (this.analyser) {
      const bins = new Uint8Array(this.analyser.frequencyBinCount)
      this.analyser.getByteFrequencyData(bins)
      for (let i = 0; i < 18; i++) {
        const start = Math.floor(i / 18 * bins.length * 0.72)
        const end = Math.max(start + 1, Math.floor((i + 1) / 18 * bins.length * 0.72))
        let total = 0
        for (let j = start; j < end; j++) total += bins[j]
        frequencies.push(total / ((end - start) * 255))
      }
    }
    if (this.listening) this.audioFrameCb?.({ amplitude: Math.min(1, Math.sqrt(sum / Math.max(1, pcm.length)) * 5), peak, frequencies })
    if (this.activity.push(pcm) && !this.stopping) {
      if (this.config.autoSubmitOnSilence) this.stop()
      else if (this.config.continuous) this.commitUtterance()
    }
  }

  private commitUtterance(): void {
    const transcript = this.transcript
    const tail = this.windows.finish()
    if (tail) this.enqueue(tail)
    this.windows = new AudioWindowBuffer()
    this.transcript = new TranscriptAssembler()
    this.activity = new SpeechActivityDetector()
    this.queue = this.queue.then(() => {
      const text = transcript.text()
      if (!this.abort.signal.aborted && text) this.resultCb?.({ text, isFinal: true })
    }).catch((error) => {
      if (!this.abort.signal.aborted) this.fail(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private enqueue(window: AudioWindow): void {
    if (this.destroyed || this.abort.signal.aborted) return
    if (++this.pendingWindows > 4) {
      this.fail(new Error('This device cannot keep up with the recording. Please try a shorter dictation.'))
      return
    }
    const transcript = this.transcript
    this.queue = this.queue.then(async () => {
      if (this.preparation) await this.waitFor(this.preparation)
      if (this.abort.signal.aborted) return
      const result = await this.client.transcribe(window.pcm, whistleLanguage(this.config.language), this.abort.signal)
      if (!this.abort.signal.aborted) transcript.append(result, window.offset)
    }).catch((error) => {
      if (!this.abort.signal.aborted) this.fail(error instanceof Error ? error : new Error(String(error)))
    }).finally(() => { this.pendingWindows-- })
  }

  stop(): void {
    if (this.destroyed || this.stopping || this.stopNotified) return
    this.stopping = true
    this.listening = false
    if (this.starting) {
      this.abort.abort()
      this.cleanup()
      this.notifyStop()
      return
    }
    this.statusCb?.({ phase: 'processing' })
    if (this.capture) {
      this.capture.port.postMessage({ type: 'stop' })
      // An unresponsive audio thread must never leave the microphone on indefinitely.
      this.flushTimer = setTimeout(() => this.fail(new Error('The microphone could not finish recording. Please try again.')), 3000)
    } else if (this.fallbackCapture) {
      this.fallbackCapture.onaudioprocess = null
      // A silence-triggered stop can run inside resampler.push(). Finish after
      // that callback returns so its fractional sample state is not re-entered.
      scheduleMicrotask(() => {
        if (this.destroyed || this.abort.signal.aborted) return
        this.fallbackResampler?.flush(this.acceptFallbackSample)
        this.flushFallbackFrame()
        void this.finish()
      })
    } else { void this.finish() }
  }

  private async finish(): Promise<void> {
    if (this.destroyed || this.stopNotified || this.finishing) return
    this.finishing = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const tail = this.windows.finish()
    if (tail) this.enqueue(tail)
    this.cleanupCapture()
    await this.queue
    if (this.destroyed || this.abort.signal.aborted || this.stopNotified) return
    this.resultCb?.({ text: this.transcript.text(), isFinal: true })
    this.cleanup()
    this.notifyStop()
  }

  private notifyStop(): void {
    if (this.stopNotified || this.destroyed) return
    this.stopNotified = true
    this.starting = this.listening = false
    this.stopCb?.()
  }

  private fail(error: Error): void {
    if (this.destroyed || this.abort.signal.aborted || this.stopNotified) return
    this.abort.abort()
    this.starting = this.listening = false
    this.cleanup()
    this.errorCb?.(error)
    this.notifyStop()
  }

  private cleanupCapture(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.capture) {
      this.capture.port.onmessage = null
      this.capture.port.close?.()
      this.capture.onprocessorerror = null
    }
    if (this.fallbackCapture) this.fallbackCapture.onaudioprocess = null
    for (const node of [this.source, this.capture, this.fallbackCapture, this.analyser, this.mute]) {
      try { node?.disconnect() } catch { /* Already disconnected. */ }
    }
    this.source = this.capture = this.analyser = this.mute = null
    this.fallbackCapture = this.fallbackResampler = null
    this.fallbackCount = 0
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop() })
    this.stream = null
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {})
    this.context = null
  }

  private cleanup(): void {
    this.cleanupCapture()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.release?.()
    this.release = null
  }

  isListening(): boolean { return this.listening }
  onResult(cb: (result: STTResult) => void): void { this.resultCb = cb }
  onError(cb: (error: Error) => void): void { this.errorCb = cb }
  onStop(cb: () => void): void { this.stopCb = cb }
  onAudioFrame(cb: (frame: STTAudioFrame) => void): void { this.audioFrameCb = cb }
  onStatus(cb: (status: STTEngineStatus) => void): void { this.statusCb = cb }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listening = this.starting = false
    this.abort.abort()
    this.cleanup()
    this.resultCb = this.errorCb = this.stopCb = this.audioFrameCb = this.statusCb = null
  }
}
