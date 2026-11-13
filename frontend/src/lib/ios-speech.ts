import { iosNativeRequest } from './ios-native'
import { uuidv4 } from './uuid'
import type { STTAudioFrame, STTConfig, STTEngine, STTEngineStatus, STTResult } from './sttEngine'

export class IOSSpeechEngine implements STTEngine {
  private id: string | null = null
  private stopping = false
  private silence: ReturnType<typeof setTimeout> | undefined
  private result?: (value: STTResult) => void
  private error?: (value: Error) => void
  private ended?: () => void
  private status?: (value: STTEngineStatus) => void
  constructor(private config: STTConfig) {}

  private event = (event: Event) => {
    const value = (event as CustomEvent).detail
    if (!this.id || value?.id !== this.id) return
    if (value.type === 'result' && typeof value.text === 'string') {
      if (value.isFinal || this.config.interimResults) this.result?.({ text: value.text, isFinal: value.isFinal === true })
      if (!this.config.continuous || this.config.autoSubmitOnSilence) {
        clearTimeout(this.silence)
        this.silence = setTimeout(() => this.stop(), 1600)
      }
    } else if (value.type === 'error') {
      this.error?.(new Error(value.message || 'Apple speech recognition failed.'))
      this.finish()
    } else if (value.type === 'end') this.finish()
  }

  async start(): Promise<void> {
    if (this.id) return
    const id = uuidv4()
    this.id = id; this.stopping = false
    window.addEventListener('lumiverse:ios-speech', this.event)
    window.addEventListener('pagehide', this.pagehide)
    try {
      await iosNativeRequest('speech.start', { id, language: this.config.language })
      if (this.id === id && !this.stopping) this.status?.({ phase: 'listening' })
    } catch (error) {
      if (this.id !== id) return
      this.error?.(error instanceof Error ? error : new Error(String(error)))
      this.finish()
    }
  }

  stop(): void {
    if (!this.id || this.stopping) return
    this.stopping = true
    clearTimeout(this.silence)
    this.status?.({ phase: 'processing' })
    void iosNativeRequest('speech.stop', { id: this.id }).catch(error => { this.error?.(error); this.finish() })
  }
  private pagehide = () => this.destroy()
  private finish(): void {
    if (!this.id) return
    this.id = null; this.stopping = false
    clearTimeout(this.silence)
    window.removeEventListener('lumiverse:ios-speech', this.event)
    window.removeEventListener('pagehide', this.pagehide)
    this.ended?.()
  }
  destroy(): void {
    if (this.id) void iosNativeRequest('speech.cancel', { id: this.id }).catch(() => {})
    this.ended = undefined
    this.finish()
    this.result = undefined; this.error = undefined; this.status = undefined
  }
  isListening(): boolean { return this.id !== null && !this.stopping }
  onResult(callback: (value: STTResult) => void): void { this.result = callback }
  onError(callback: (value: Error) => void): void { this.error = callback }
  onStop(callback: () => void): void { this.ended = callback }
  onStatus(callback: (value: STTEngineStatus) => void): void { this.status = callback }
  // Native recognition owns its microphone; don't open a second WebKit capture stream.
  onAudioFrame(_callback: (value: STTAudioFrame) => void): void {}
}
