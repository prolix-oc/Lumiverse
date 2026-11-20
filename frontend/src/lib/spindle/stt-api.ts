import type { STTConfig, STTEngine } from '../sttEngine'
import type {
  SpindleSTTAPI, SpindleSTTOptions, SpindleSTTProviderOption, SpindleSTTSession,
  SpindleSTTStartOptions, SpindleSTTTranscript, SpindleSTTPcmAudio, SpindleSTTTranscribeOptions,
} from 'lumiverse-spindle-types'

export interface STTTranscribeExtras {
  keywords?: readonly string[]
  words: boolean
}

export interface FrontendSTTDependencies {
  assertActive(): void
  requirePermission(permission: string, member: string): void
  onTeardown(handler: () => void): () => void
  getConfig(): STTConfig
  listProviders(): SpindleSTTProviderOption[]
  createEngine(config: STTConfig): STTEngine
  prepare(config: STTConfig, signal: AbortSignal, onStatus: SpindleSTTOptions['onStatus']): Promise<void>
  transcribe(audio: Blob | SpindleSTTPcmAudio, config: STTConfig, signal: AbortSignal, onStatus: SpindleSTTOptions['onStatus'], extras: STTTranscribeExtras): Promise<SpindleSTTTranscript>
  isHostCapturing(): boolean
  subscribeHostCapture(listener: (active: boolean) => void): () => void
}

// Extensions in one document share microphone ownership; the shared Whistle
// worker can still transcribe supplied audio and prepare independently.
let captureOwner: symbol | null = null
const aborted = () => new DOMException('Speech recognition cancelled', 'AbortError')
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error))
const MAX_KEYWORDS = 500
const MAX_KEYWORD_LENGTH = 100

function transcribeExtras(options: SpindleSTTTranscribeOptions): STTTranscribeExtras {
  const { keywords, words } = options
  if (words !== undefined && typeof words !== 'boolean') throw new Error('STT_OPTIONS_INVALID: words must be a boolean')
  if (keywords === undefined) return { words: words === true }
  if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS) {
    throw new Error(`STT_OPTIONS_INVALID: keywords must be an array of at most ${MAX_KEYWORDS} strings`)
  }
  const copy = Array.from(keywords, (keyword) => {
    const value = typeof keyword === 'string' ? keyword.trim() : ''
    if (!value || value.length > MAX_KEYWORD_LENGTH || /[\0\r\n\u2028\u2029]/.test(keyword)) {
      throw new Error(`STT_OPTIONS_INVALID: each keyword must be 1-${MAX_KEYWORD_LENGTH} characters without line breaks or NUL`)
    }
    return value
  })
  return { keywords: copy, words: words === true }
}

export function createFrontendSTTAPI(deps: FrontendSTTDependencies) {
  let disposed = false
  const operations = new Set<AbortController>()
  const hostCaptureSubscriptions = new Set<() => void>()
  const assertLive = () => {
    deps.assertActive()
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: speech API has been disposed')
  }
  const authorize = (member: string) => {
    assertLive()
    deps.requirePermission('media', member)
  }
  const configFor = (options: SpindleSTTOptions, capture = false): STTConfig => {
    const defaults = deps.getConfig()
    const provider = options.provider ?? defaults.provider
    if (!['webspeech', 'whistle', 'connection'].includes(provider)) throw new Error('STT_PROVIDER_INVALID')
    return {
      ...defaults, provider,
      language: options.language ?? defaults.language,
      connectionId: options.connectionId ?? defaults.connectionId,
      // Extension recordings end on silence by default, independently of chat preferences.
      ...(capture ? { continuous: (options as SpindleSTTStartOptions).continuous ?? false,
        interimResults: (options as SpindleSTTStartOptions).interimResults ?? defaults.interimResults,
        autoSubmitOnSilence: !(options as SpindleSTTStartOptions).continuous } : {}),
    }
  }
  const begin = (signal?: AbortSignal) => {
    const controller = new AbortController()
    const cancel = () => controller.abort(aborted())
    if (signal?.aborted) throw aborted()
    signal?.addEventListener('abort', cancel, { once: true })
    operations.add(controller)
    return {
      controller,
      finish() { operations.delete(controller); signal?.removeEventListener('abort', cancel) },
    }
  }
  const notify = <T>(controller: AbortController, member: string, callback: ((value: T) => void) | undefined, value: T) => {
    if (controller.signal.aborted) return
    try { authorize(member) } catch (error) { controller.abort(asError(error)); return }
    if (!callback) return
    try { callback(value) } catch (error) { console.error('[Spindle] Speech callback failed', error) }
  }
  const run = async <T>(member: string, options: SpindleSTTOptions, task: (
    config: STTConfig, signal: AbortSignal, onStatus: SpindleSTTOptions['onStatus'],
  ) => Promise<T>): Promise<T> => {
    authorize(member)
    const config = configFor(options)
    const operation = begin(options.signal)
    const { controller } = operation
    let cancel!: () => void
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () => reject(controller.signal.reason ?? aborted())
      controller.signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      const result = await Promise.race([
        task(config, controller.signal, (status) => notify(controller, member, options.onStatus, { ...status })),
        cancellation,
      ])
      authorize(member)
      if (controller.signal.aborted) throw controller.signal.reason ?? aborted()
      return result
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      operation.finish()
    }
  }
  const api: SpindleSTTAPI = {
    listProviders() {
      assertLive()
      return deps.listProviders().map((provider) => ({ ...provider,
        ...(provider.languages ? { languages: [...provider.languages] } : {}),
      }))
    },
    prepare(options = {}) { return run('ctx.stt.prepare', options, deps.prepare) },
    transcribe(audio, options = {}) {
      return run('ctx.stt.transcribe', options, (config, signal, onStatus) =>
        deps.transcribe(audio, config, signal, onStatus, transcribeExtras(options)))
    },
    onHostActivity(listener) {
      assertLive()
      if (typeof listener !== 'function') throw new Error('STT_OPTIONS_INVALID: listener must be a function')
      let subscribed = true
      const unsubscribe = deps.subscribeHostCapture((active) => {
        if (!subscribed) return
        try { assertLive() } catch { return }
        try { listener(active) } catch (error) { console.error('[Spindle] Speech callback failed', error) }
      })
      const release = () => {
        if (!subscribed) return
        subscribed = false
        unsubscribe()
        hostCaptureSubscriptions.delete(release)
      }
      hostCaptureSubscriptions.add(release)
      return release
    },
    isHostCapturing() {
      assertLive()
      return deps.isHostCapturing()
    },
    start(options = {}) {
      const member = 'ctx.stt.start'
      authorize(member)
      const config = configFor(options, true)
      const operation = begin(options.signal)
      const { controller } = operation
      if (captureOwner) { operation.finish(); throw new Error('STT_BUSY: another extension is recording') }
      const owner = Symbol('extension-stt')
      captureOwner = owner
      let engine: STTEngine
      try { engine = deps.createEngine(config) }
      catch (error) { captureOwner = null; operation.finish(); throw error }
      let settled = false
      let started = false
      let stopRequested = false
      const final: string[] = []
      let interim = ''
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      let resolveResult!: (result: SpindleSTTTranscript) => void
      let rejectResult!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      const result = new Promise<SpindleSTTTranscript>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
      // Callback-only consumers need not await both promises. They remain rejecting
      // promises for callers that do await, without leaking unhandled rejections.
      void ready.catch(() => {})
      void result.catch(() => {})
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        controller.signal.removeEventListener('abort', cancel)
        try { engine.destroy() } catch (cleanupError) {
          console.error('[Spindle] Speech cleanup failed', cleanupError)
        } finally {
          if (captureOwner === owner) captureOwner = null
          operation.finish()
        }
        if (error) { rejectReady(error); rejectResult(error) }
        else {
          resolveReady()
          resolveResult({ text: [...final, interim].filter(Boolean).join(' ').trim(), provider: config.provider,
            ...(config.language && config.language !== 'auto' ? { language: config.language } : {}),
          })
        }
      }
      const cancel = () => finish(asError(controller.signal.reason ?? aborted()))
      controller.signal.addEventListener('abort', cancel, { once: true })
      engine.onResult((update) => {
        if (settled) return
        notify(controller, member, undefined, undefined)
        if (settled) return
        if (update.isFinal) { if (update.text.trim()) final.push(update.text.trim()); interim = '' }
        else interim = update.text.trim()
        notify(controller, member, options.onResult, { ...update })
      })
      engine.onAudioFrame((frame) => {
        if (!settled) notify(controller, member, options.onAudioFrame, { ...frame, frequencies: [...frame.frequencies] })
      })
      engine.onStatus?.((status) => {
        if (!settled) notify(controller, member, options.onStatus, { ...status })
      })
      engine.onError((error) => finish(error))
      engine.onStop(() => {
        if (settled) return
        try { authorize(member); finish() } catch (error) { finish(asError(error)) }
      })
      const session: SpindleSTTSession = {
        provider: config.provider, ready, result,
        stop() {
          if (!settled && !stopRequested) {
            stopRequested = true
            if (started) {
              try { engine.stop() } catch (error) { finish(asError(error)) }
            }
          }
          return result
        },
        cancel() { if (!settled) controller.abort(aborted()) },
      }
      try {
        // Start synchronously to preserve the extension's button user gesture.
        const startup = engine.start()
        void Promise.resolve(startup).then(() => {
          if (settled) return
          authorize(member)
          started = true
          resolveReady()
          if (stopRequested) engine.stop()
          else if (!engine.onStatus) notify(controller, member, options.onStatus, { phase: 'listening' })
        }).catch((error) => finish(asError(error)))
      } catch (error) { finish(asError(error)) }
      return Object.freeze(session)
    },
  }
  const revoke = () => { for (const operation of [...operations]) operation.abort(aborted()) }
  const dispose = () => {
    if (disposed) return
    disposed = true
    revoke()
    for (const release of [...hostCaptureSubscriptions]) release()
  }
  deps.onTeardown(dispose)
  return { api, revoke, dispose }
}
