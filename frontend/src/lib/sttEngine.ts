import { sttApi } from '@/api/stt'

export interface STTResult {
  text: string
  isFinal: boolean
}

export interface STTAudioFrame {
  amplitude: number
  peak: number
  frequencies: number[]
}

export interface STTAudioFormat {
  mimeType: string
  fileName: string
}

export interface STTEngine {
  start(): void | Promise<void>
  stop(): void
  onResult(cb: (result: STTResult) => void): void
  onError(cb: (err: Error) => void): void
  onStop(cb: () => void): void
  onAudioFrame(cb: (frame: STTAudioFrame) => void): void
  isListening(): boolean
  destroy(): void
}

export interface STTConfig {
  provider: 'webspeech' | 'connection'
  language: string
  continuous: boolean
  interimResults: boolean
  autoSubmitOnSilence?: boolean
  connectionId?: string | null
}

const STT_VAD_CHECK_MS = 50
const STT_VAD_MIN_RECORDING_MS = 900
const STT_VAD_MIN_SPEECH_MS = 140
const STT_VAD_SILENCE_MS = 1600
const STT_VAD_MIN_THRESHOLD = 0.012
const STT_VAD_NOISE_MULTIPLIER = 3
const WEB_SPEECH_SILENCE_MS = 1600
const WEB_SPEECH_RESTART_MS = 80
const STT_VISUALIZER_BINS = 18

type AudioVisualizerHandle = {
  stop(): void
}

function createAudioVisualizer(stream: MediaStream, cb: ((frame: STTAudioFrame) => void) | null): AudioVisualizerHandle | null {
  if (!cb || typeof window === 'undefined') return null

  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextClass || typeof requestAnimationFrame === 'undefined') return null

  let audioContext: AudioContext | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let rafId = 0

  try {
    audioContext = new AudioContextClass()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.76
    sourceNode = audioContext.createMediaStreamSource(stream)
    sourceNode.connect(analyser)
  } catch {
    try { sourceNode?.disconnect() } catch { /* ignore */ }
    try { analyser?.disconnect() } catch { /* ignore */ }
    if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => {})
    return null
  }

  const samples = new Float32Array(analyser.fftSize)
  const frequencies = new Uint8Array(analyser.frequencyBinCount)
  let lastEmitAt = 0

  const tick = () => {
    if (!analyser) return
    const now = performance.now()
    if (now - lastEmitAt < 33) {
      rafId = requestAnimationFrame(tick)
      return
    }
    lastEmitAt = now

    analyser.getFloatTimeDomainData(samples)
    analyser.getByteFrequencyData(frequencies)

    let sum = 0
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i])
      sum += samples[i] * samples[i]
      if (abs > peak) peak = abs
    }

    const bins: number[] = []
    const usableLength = Math.floor(frequencies.length * 0.72)
    for (let i = 0; i < STT_VISUALIZER_BINS; i++) {
      const start = Math.floor((i / STT_VISUALIZER_BINS) * usableLength)
      const end = Math.max(start + 1, Math.floor(((i + 1) / STT_VISUALIZER_BINS) * usableLength))
      let total = 0
      for (let j = start; j < end; j++) total += frequencies[j]
      bins.push(Math.min(1, total / ((end - start) * 255)))
    }

    cb({
      amplitude: Math.min(1, Math.sqrt(sum / samples.length) * 5),
      peak: Math.min(1, peak),
      frequencies: bins,
    })
    rafId = requestAnimationFrame(tick)
  }

  rafId = requestAnimationFrame(tick)

  return {
    stop() {
      if (rafId) cancelAnimationFrame(rafId)
      try { sourceNode?.disconnect() } catch { /* ignore */ }
      try { analyser?.disconnect() } catch { /* ignore */ }
      if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => {})
      sourceNode = null
      analyser = null
      audioContext = null
    },
  }
}

/**
 * Factory — returns the appropriate STT engine based on config.
 */
export function createSTTEngine(config: STTConfig): STTEngine {
  if (config.provider === 'webspeech') {
    return new WebSpeechEngine(config)
  }
  return new OpenAISTTEngine(config)
}

// ── Web Speech API ──────────────────────────────────────────────────

const SpeechRecognitionClass =
  typeof window !== 'undefined'
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null

export function isWebSpeechAvailable(): boolean {
  return SpeechRecognitionClass != null
}

export function getSupportedSTTAudioFormat(): STTAudioFormat | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null

  const candidates: STTAudioFormat[] = [
    { mimeType: 'audio/webm;codecs=opus', fileName: 'recording.webm' },
    { mimeType: 'audio/webm', fileName: 'recording.webm' },
    { mimeType: 'audio/mp4', fileName: 'recording.mp4' },
    { mimeType: 'audio/mp4;codecs=mp4a.40.2', fileName: 'recording.m4a' },
    { mimeType: 'audio/aac', fileName: 'recording.aac' },
  ]

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate
  }

  return { mimeType: '', fileName: 'recording.webm' }
}

class WebSpeechEngine implements STTEngine {
  private recognition: any = null
  private resultCb: ((r: STTResult) => void) | null = null
  private errorCb: ((e: Error) => void) | null = null
  private stopCb: (() => void) | null = null
  private audioFrameCb: ((frame: STTAudioFrame) => void) | null = null
  private visualizerStream: MediaStream | null = null
  private visualizerHandle: AudioVisualizerHandle | null = null
  private listening = false
  private active = false
  private stopping = false
  private stopNotified = false
  private hasResult = false
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private config: STTConfig) {
    if (!SpeechRecognitionClass) {
      throw new Error('Web Speech API is not available in this browser')
    }
    this.recognition = new SpeechRecognitionClass()
    // Safari can end a recognition session at short pauses even when the user
    // is still dictating. Keep the browser recognizer continuous and decide
    // app-level stopping with our own silence timer below.
    this.recognition.continuous = true
    this.recognition.interimResults = config.interimResults
    this.recognition.lang = config.language

    this.recognition.onstart = () => {
      this.active = true
    }

    this.recognition.onspeechstart = () => {
      this.clearSilenceTimer()
    }

    this.recognition.onspeechend = () => {
      this.scheduleSilenceStop()
    }

    this.recognition.onsoundend = () => {
      this.scheduleSilenceStop()
    }

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        this.hasResult = true
        if (!result.isFinal) this.clearSilenceTimer()
        this.resultCb?.({
          text: result[0].transcript,
          isFinal: result.isFinal,
        })
        if (result.isFinal) this.scheduleSilenceStop()
      }
    }

    this.recognition.onerror = (event: any) => {
      if (event.error === 'no-speech' && this.listening && (this.config.continuous || this.hasResult)) {
        this.scheduleSilenceStop()
        return
      }
      if (event.error === 'aborted' && this.stopping) return

      const msg = event.error === 'not-allowed'
        ? 'Microphone permission denied'
        : event.error === 'no-speech'
          ? 'No speech detected'
          : `Speech recognition error: ${event.error}`
      this.errorCb?.(new Error(msg))
    }

    this.recognition.onend = () => {
      this.active = false
      if (this.listening && !this.stopping) {
        this.scheduleRestart()
        return
      }

      if (this.stopping || !this.listening) {
        this.listening = false
        this.stopping = false
        this.notifyStop()
      }
    }
  }

  private shouldStopOnSilence(): boolean {
    return this.config.autoSubmitOnSilence === true || !this.config.continuous
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private scheduleSilenceStop(): void {
    if (!this.listening || !this.shouldStopOnSilence()) return
    this.clearSilenceTimer()
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      if (!this.listening) return
      this.stop()
    }, WEB_SPEECH_SILENCE_MS)
  }

  private scheduleRestart(): void {
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.listening || this.stopping || this.active) return
      try { this.recognition.start() } catch { /* ignore duplicate starts */ }
    }, WEB_SPEECH_RESTART_MS)
  }

  private notifyStop(): void {
    if (this.stopNotified) return
    this.stopNotified = true
    this.stopMicVisualizer()
    this.stopCb?.()
  }

  private startMicVisualizer(): void {
    if (!this.audioFrameCb || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
    void navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        if (!this.listening || this.visualizerStream) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        this.visualizerStream = stream
        this.visualizerHandle = createAudioVisualizer(stream, this.audioFrameCb)
      })
      .catch(() => {})
  }

  private stopMicVisualizer(): void {
    this.visualizerHandle?.stop()
    this.visualizerHandle = null
    if (this.visualizerStream) {
      this.visualizerStream.getTracks().forEach((track) => track.stop())
      this.visualizerStream = null
    }
  }

  start(): void {
    this.clearSilenceTimer()
    this.clearRestartTimer()
    this.listening = true
    this.stopping = false
    this.stopNotified = false
    this.hasResult = false
    this.startMicVisualizer()
    this.recognition.start()
  }

  stop(): void {
    this.clearSilenceTimer()
    this.clearRestartTimer()
    this.listening = false
    this.stopping = true
    this.stopMicVisualizer()
    try { this.recognition.stop() } catch { /* ignore */ }
    if (!this.active) {
      this.stopping = false
      this.notifyStop()
    }
  }

  onResult(cb: (r: STTResult) => void): void {
    this.resultCb = cb
  }

  onError(cb: (e: Error) => void): void {
    this.errorCb = cb
  }

  onStop(cb: () => void): void {
    this.stopCb = cb
  }

  onAudioFrame(cb: (frame: STTAudioFrame) => void): void {
    this.audioFrameCb = cb
  }

  isListening(): boolean {
    return this.listening
  }

  destroy(): void {
    this.clearSilenceTimer()
    this.clearRestartTimer()
    this.listening = false
    this.stopping = true
    this.stopMicVisualizer()
    try { this.recognition.abort() } catch { /* ignore */ }
    this.resultCb = null
    this.errorCb = null
    this.stopCb = null
    this.audioFrameCb = null
  }
}

// ── OpenAI STT (MediaRecorder → backend proxy) ─────────────────────

class OpenAISTTEngine implements STTEngine {
  private resultCb: ((r: STTResult) => void) | null = null
  private errorCb: ((e: Error) => void) | null = null
  private stopCb: (() => void) | null = null
  private audioFrameCb: ((frame: STTAudioFrame) => void) | null = null
  private listening = false
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private audioFormat: STTAudioFormat | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private visualizerHandle: AudioVisualizerHandle | null = null
  private vadTimer: ReturnType<typeof setTimeout> | null = null
  private recordingStartedAt = 0
  private speechMs = 0
  private lastSpeechAt = 0
  private lastVadCheckAt = 0
  private noiseFloor = 0.006
  private speechConfirmed = false

  constructor(private config: STTConfig) {}

  private cleanupStream(): void {
    this.stopSilenceMonitor()
    this.stopAudioVisualizer()
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
  }

  private cleanupAudioContext(): void {
    try { this.sourceNode?.disconnect() } catch { /* ignore */ }
    try { this.analyser?.disconnect() } catch { /* ignore */ }
    const audioContext = this.audioContext
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => {})
    }
    this.sourceNode = null
    this.analyser = null
    this.audioContext = null
  }

  private stopSilenceMonitor(): void {
    if (this.vadTimer !== null) {
      clearTimeout(this.vadTimer)
      this.vadTimer = null
    }
    this.cleanupAudioContext()
  }

  private startAudioVisualizer(): void {
    if (!this.stream || this.visualizerHandle) return
    this.visualizerHandle = createAudioVisualizer(this.stream, this.audioFrameCb)
  }

  private stopAudioVisualizer(): void {
    this.visualizerHandle?.stop()
    this.visualizerHandle = null
  }

  private cleanupRecorder(): void {
    this.mediaRecorder = null
    this.chunks = []
    this.audioFormat = null
    this.recordingStartedAt = 0
    this.speechMs = 0
    this.lastSpeechAt = 0
    this.lastVadCheckAt = 0
    this.noiseFloor = 0.006
    this.speechConfirmed = false
  }

  private startSilenceMonitor(): void {
    if (!this.stream || !this.config.autoSubmitOnSilence) return

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextClass) return

    try {
      this.audioContext = new AudioContextClass()
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 2048
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.sourceNode.connect(this.analyser)
    } catch {
      this.cleanupAudioContext()
      return
    }

    const samples = new Float32Array(this.analyser.fftSize)
    const check = () => {
      if (!this.analyser || !this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
        this.vadTimer = null
        return
      }

      const now = performance.now()
      const deltaMs = this.lastVadCheckAt ? now - this.lastVadCheckAt : STT_VAD_CHECK_MS
      this.lastVadCheckAt = now

      this.analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      const rms = Math.sqrt(sum / samples.length)
      const threshold = Math.max(STT_VAD_MIN_THRESHOLD, this.noiseFloor * STT_VAD_NOISE_MULTIPLIER)

      if (rms >= threshold) {
        this.speechMs += deltaMs
        this.lastSpeechAt = now
        if (this.speechMs >= STT_VAD_MIN_SPEECH_MS) this.speechConfirmed = true
      } else if (!this.speechConfirmed) {
        this.speechMs = Math.max(0, this.speechMs - deltaMs)
        this.noiseFloor = (this.noiseFloor * 0.95) + (rms * 0.05)
      }

      const recordingMs = now - this.recordingStartedAt
      const silentMs = this.lastSpeechAt ? now - this.lastSpeechAt : 0
      if (this.speechConfirmed && recordingMs >= STT_VAD_MIN_RECORDING_MS && silentMs >= STT_VAD_SILENCE_MS) {
        this.listening = false
        this.mediaRecorder.stop()
        this.stopSilenceMonitor()
        return
      }

      this.vadTimer = setTimeout(check, STT_VAD_CHECK_MS)
    }

    this.vadTimer = setTimeout(check, STT_VAD_CHECK_MS)
  }

  async start(): Promise<void> {
    const audioFormat = getSupportedSTTAudioFormat()
    if (!audioFormat) {
      this.errorCb?.(new Error('Audio recording is not supported in this browser'))
      return
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      this.errorCb?.(new Error('Microphone permission denied'))
      return
    }

    this.listening = true
    this.chunks = []
    this.audioFormat = audioFormat
    this.startAudioVisualizer()

    this.mediaRecorder = audioFormat.mimeType
      ? new MediaRecorder(this.stream, { mimeType: audioFormat.mimeType })
      : new MediaRecorder(this.stream)

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    this.mediaRecorder.onstop = async () => {
      if (this.chunks.length === 0) {
        this.cleanupStream()
        this.cleanupRecorder()
        this.resultCb?.({ text: '', isFinal: true })
        this.stopCb?.()
        return
      }

      const blob = new Blob(this.chunks, { type: this.audioFormat?.mimeType || 'audio/webm' })
      this.chunks = []

      try {
        const result = await sttApi.transcribe(blob, {
          language: this.config.language,
          connectionId: this.config.connectionId || undefined,
          fileName: this.audioFormat?.fileName,
        })
        this.resultCb?.({ text: result.text, isFinal: true })
      } catch (err) {
        this.errorCb?.(err instanceof Error ? err : new Error(String(err)))
      }

      // Auto-restart in continuous mode
      if (this.listening && this.config.continuous) {
        this.startRecording()
      } else {
        this.cleanupStream()
        this.cleanupRecorder()
        this.stopCb?.()
      }
    }

    this.startRecording()
  }

  private startRecording(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'recording') return
    this.chunks = []
    this.recordingStartedAt = performance.now()
    this.speechMs = 0
    this.lastSpeechAt = 0
    this.lastVadCheckAt = 0
    this.noiseFloor = 0.006
    this.speechConfirmed = false
    this.mediaRecorder.start()
    this.startSilenceMonitor()
  }

  stop(): void {
    this.listening = false
    this.stopSilenceMonitor()
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop()
    }
  }

  onResult(cb: (r: STTResult) => void): void {
    this.resultCb = cb
  }

  onError(cb: (e: Error) => void): void {
    this.errorCb = cb
  }

  onStop(cb: () => void): void {
    this.stopCb = cb
  }

  onAudioFrame(cb: (frame: STTAudioFrame) => void): void {
    this.audioFrameCb = cb
  }

  isListening(): boolean {
    return this.listening
  }

  destroy(): void {
    this.listening = false
    this.stopSilenceMonitor()
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop() } catch { /* ignore */ }
    }
    this.cleanupStream()
    this.cleanupRecorder()
    this.resultCb = null
    this.errorCb = null
    this.stopCb = null
    this.audioFrameCb = null
  }
}
