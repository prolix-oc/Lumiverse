import { PcmResampler } from './audio'

declare const sampleRate: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class WhistleCaptureProcessor extends AudioWorkletProcessor {
  private resampler = new PcmResampler(sampleRate)
  private frame = new Float32Array(1600) // 100 ms at 16 kHz.
  private count = 0
  private recording = true

  constructor() {
    super()
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'stop' || !this.recording) return
      this.recording = false
      this.resampler.flush(this.emit)
      this.flush()
      // Acknowledgement follows the last PCM frame on the same ordered message port.
      this.port.postMessage({ type: 'stopped' })
    }
  }

  private flush(): void {
    if (!this.count) return
    const pcm = this.frame.slice(0, this.count)
    this.port.postMessage({ type: 'audio', pcm }, [pcm.buffer])
    this.count = 0
  }

  private emit = (sample: number): void => {
    this.frame[this.count++] = sample
    if (this.count === this.frame.length) this.flush()
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (this.recording && channels?.[0]) this.resampler.push(channels[0], this.emit)
    return true // The engine disconnects the node after receiving the final frame.
  }
}

registerProcessor('lumiverse-whistle-capture', WhistleCaptureProcessor)
