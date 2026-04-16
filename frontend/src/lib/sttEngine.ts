import { sttApi } from '@/api/stt'

export interface STTResult {
  text: string
  isFinal: boolean
}

export interface STTEngine {
  start(): void
  stop(): void
  onResult(cb: (result: STTResult) => void): void
  onError(cb: (err: Error) => void): void
  isListening(): boolean
  destroy(): void
}

export interface STTConfig {
  provider: 'webspeech' | 'openai'
  language: string
  continuous: boolean
  interimResults: boolean
  connectionId?: string | null
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

class WebSpeechEngine implements STTEngine {
  private recognition: any = null
  private resultCb: ((r: STTResult) => void) | null = null
  private errorCb: ((e: Error) => void) | null = null
  private listening = false

  constructor(private config: STTConfig) {
    if (!SpeechRecognitionClass) {
      throw new Error('Web Speech API is not available in this browser')
    }
    this.recognition = new SpeechRecognitionClass()
    this.recognition.continuous = config.continuous
    this.recognition.interimResults = config.interimResults
    this.recognition.lang = config.language

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        this.resultCb?.({
          text: result[0].transcript,
          isFinal: result.isFinal,
        })
      }
    }

    this.recognition.onerror = (event: any) => {
      const msg = event.error === 'not-allowed'
        ? 'Microphone permission denied'
        : event.error === 'no-speech'
          ? 'No speech detected'
          : `Speech recognition error: ${event.error}`
      this.errorCb?.(new Error(msg))
    }

    this.recognition.onend = () => {
      if (this.listening && this.config.continuous) {
        // Auto-restart in continuous mode
        try { this.recognition.start() } catch { /* ignore */ }
      } else {
        this.listening = false
      }
    }
  }

  start(): void {
    this.listening = true
    this.recognition.start()
  }

  stop(): void {
    this.listening = false
    this.recognition.stop()
  }

  onResult(cb: (r: STTResult) => void): void {
    this.resultCb = cb
  }

  onError(cb: (e: Error) => void): void {
    this.errorCb = cb
  }

  isListening(): boolean {
    return this.listening
  }

  destroy(): void {
    this.listening = false
    try { this.recognition.abort() } catch { /* ignore */ }
    this.resultCb = null
    this.errorCb = null
  }
}

// ── OpenAI STT (MediaRecorder → backend proxy) ─────────────────────

class OpenAISTTEngine implements STTEngine {
  private resultCb: ((r: STTResult) => void) | null = null
  private errorCb: ((e: Error) => void) | null = null
  private listening = false
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []

  constructor(private config: STTConfig) {}

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      this.errorCb?.(new Error('Microphone permission denied'))
      return
    }

    this.listening = true
    this.chunks = []

    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    })

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    this.mediaRecorder.onstop = async () => {
      if (this.chunks.length === 0) return
      const blob = new Blob(this.chunks, { type: 'audio/webm' })
      this.chunks = []

      try {
        const result = await sttApi.transcribe(blob, {
          language: this.config.language,
          connectionId: this.config.connectionId || undefined,
        })
        this.resultCb?.({ text: result.text, isFinal: true })
      } catch (err) {
        this.errorCb?.(err instanceof Error ? err : new Error(String(err)))
      }

      // Auto-restart in continuous mode
      if (this.listening && this.config.continuous) {
        this.startRecording()
      }
    }

    this.startRecording()
  }

  private startRecording(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'recording') return
    this.chunks = []
    this.mediaRecorder.start()
  }

  stop(): void {
    this.listening = false
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

  isListening(): boolean {
    return this.listening
  }

  destroy(): void {
    this.listening = false
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop() } catch { /* ignore */ }
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    this.resultCb = null
    this.errorCb = null
  }
}
