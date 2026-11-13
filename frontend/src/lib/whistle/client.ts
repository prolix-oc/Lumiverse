import type { WhistleRequest, WhistleResponse, WhistleState, WhistleTranscript } from './config'

interface PendingRequest {
  resolve(value?: WhistleTranscript): void
  reject(error: Error): void
  cleanup(): void
}

export class WhistleClient {
  private worker: Worker | null = null
  private state: WhistleState = { phase: 'idle', progress: 0 }
  private listeners = new Set<() => void>()
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private preparation: Promise<void> | null = null
  private leases = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private spawn: () => Worker = () => new Worker(new URL('./whistle.worker.ts', import.meta.url), {
    type: 'module', name: 'lumiverse-whistle',
  })) {}

  getState = (): WhistleState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(state: WhistleState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  retain(): () => void {
    this.leases++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    let released = false
    return () => {
      if (released) return
      released = true
      this.leases--
      this.scheduleIdle()
    }
  }

  private scheduleIdle(): void {
    if (this.leases || this.pending.size || this.idleTimer || !this.worker) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.leases && !this.pending.size) {
        this.worker?.terminate()
        this.worker = null
        this.publish({ phase: 'idle', progress: 0 })
      }
    }, 5 * 60_000)
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = this.spawn()
      worker.onmessage = ({ data }: MessageEvent<WhistleResponse>) => {
        if (this.worker !== worker) return
        if (data.type === 'progress') {
          this.publish({ phase: 'loading', progress: Math.max(0, Math.min(1, data.progress)) })
          return
        }
        const request = this.pending.get(data.id)
        if (!request) return
        this.pending.delete(data.id)
        request.cleanup()
        if (data.type === 'error') request.reject(new Error(data.error))
        else request.resolve(data.type === 'result' ? data.result : undefined)
        this.scheduleIdle()
      }
      worker.onerror = (event) => {
        if (this.worker === worker) this.fail(new Error(event.message || 'Whistle could not start on this device.'))
      }
      worker.onmessageerror = () => {
        if (this.worker === worker) this.fail(new Error('Whistle could not read its transcription result.'))
      }
      this.worker = worker
    }
    return this.worker
  }

  private fail(error: Error): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.worker?.terminate()
    this.worker = null
    for (const request of this.pending.values()) {
      request.cleanup()
      request.reject(error)
    }
    this.pending.clear()
    this.publish({ phase: 'error', progress: 0, error: error.message })
  }

  private request(message: WhistleRequest, signal?: AbortSignal): Promise<WhistleTranscript | undefined> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Recording cancelled', 'AbortError')); return }
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = null
      const cancel = () => {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        pending.cleanup()
        reject(new DOMException('Recording cancelled', 'AbortError'))
        this.scheduleIdle()
      }
      const timer = setTimeout(() => this.fail(new Error(message.type === 'prepare'
        ? 'Whistle took too long to prepare. Please try again.'
        : 'Transcription took too long on this device. Please try again.')), message.type === 'prepare' ? 150_000 : 60_000)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
      this.pending.set(message.id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        this.ensureWorker().postMessage(message, message.type === 'transcribe' ? [message.pcm.buffer as ArrayBuffer] : [])
      } catch (error) {
        this.pending.delete(message.id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  prepare(): Promise<void> {
    if (this.state.phase === 'ready') return Promise.resolve()
    if (this.preparation) return this.preparation
    this.publish({ phase: 'loading', progress: 0 })
    this.preparation = this.request({ type: 'prepare', id: this.nextId++ })
      .then(() => { this.publish({ phase: 'ready', progress: 1 }) })
      .catch((error) => { this.fail(error); throw error })
      .finally(() => { this.preparation = null })
    return this.preparation
  }

  async transcribe(pcm: Float32Array, language?: string, signal?: AbortSignal, keywords?: readonly string[]): Promise<WhistleTranscript> {
    await this.prepare()
    if (signal?.aborted) throw new DOMException('Recording cancelled', 'AbortError')
    try {
      const result = await this.request({ type: 'transcribe', id: this.nextId++, pcm, language, ...(keywords?.length ? { keywords } : {}) }, signal)
      if (!result) throw new Error('Whistle returned no transcription result.')
      return result
    } catch (error) {
      if (!signal?.aborted) this.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /** Disposes the worker and settles every waiter, also used by lifecycle tests. */
  dispose(): void {
    this.fail(new DOMException('Whistle closed', 'AbortError'))
    this.publish({ phase: 'idle', progress: 0 })
  }
}

export const whistleClient = new WhistleClient()
