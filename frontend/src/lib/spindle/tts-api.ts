import type { SpindleTTSAPI, SpindleTTSSpeakInput, SpindleTTSSpeakOptions } from 'lumiverse-spindle-types'

/** One started playback. `session` is the engine session it owns. */
export interface TTSPlayback {
  session: number
  /** Settles when synthesis has finished; rejects when it failed. */
  synthesized: Promise<void>
  cancel(): void
}

export interface FrontendTTSDependencies {
  assertActive(): void
  requirePermission(permission: string, member: string): void
  onTeardown(handler: () => void): () => void
  /** Engine playback or a playing saved-message audio element. */
  isSpeaking(): boolean
  isEngineSpeaking(): boolean
  getSession(): number
  /** Called on every playback transition. */
  subscribe(listener: () => void): () => void
  /** Validates, stops current playback, and starts the new one synchronously. */
  start(input: SpindleTTSSpeakInput, options: SpindleTTSSpeakOptions): TTSPlayback
  stopEngine(): void
  stopAll(): void
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export function createFrontendTTSAPI(deps: FrontendTTSDependencies) {
  let disposed = false
  const owned = new Set<number>()
  const unsubscribers = new Set<() => void>()
  const assertUsable = () => {
    deps.assertActive()
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: speech API has been disposed')
  }
  const authorize = (member: string) => {
    assertUsable()
    deps.requirePermission('media', member)
  }
  const isCurrent = (session: number) => deps.getSession() === session && deps.isEngineSpeaking()

  const api: SpindleTTSAPI = {
    async speak(input: SpindleTTSSpeakInput, options: SpindleTTSSpeakOptions = {}) {
      authorize('ctx.tts.speak')
      if (!input || typeof input !== 'object' || !options || typeof options !== 'object') {
        throw new Error('TTS_INPUT_INVALID: pass a non-empty text or messageId')
      }
      const text = 'text' in input ? input.text : undefined
      const messageId = 'messageId' in input ? input.messageId : undefined
      if ((text !== undefined && messageId !== undefined) || isNonEmptyString(text) === isNonEmptyString(messageId)) {
        throw new Error('TTS_INPUT_INVALID: pass a non-empty text or messageId')
      }
      if (messageId !== undefined && options.connectionId !== undefined) {
        throw new Error('TTS_INPUT_INVALID: connectionId applies to text only')
      }
      if (options.connectionId !== undefined && !isNonEmptyString(options.connectionId)) {
        throw new Error('TTS_INPUT_INVALID: connectionId must be a non-empty string')
      }
      const playback = deps.start(input, options)
      owned.add(playback.session)
      const failure = playback.synthesized.then(() => null, (error: unknown) => ({ error }))
      try {
        if (isCurrent(playback.session)) {
          await new Promise<void>((resolve) => {
            const unsubscribe = deps.subscribe(() => {
              if (isCurrent(playback.session)) return
              unsubscribe()
              resolve()
            })
          })
        }
      } finally {
        owned.delete(playback.session)
      }
      // A natural end means synthesis is done; after a stop, cancel the rest and ignore its errors.
      if (deps.getSession() !== playback.session) {
        playback.cancel()
        return
      }
      const failed = await failure
      if (failed) throw failed.error
    },
    stop() {
      authorize('ctx.tts.stop')
      deps.stopAll()
    },
    isSpeaking() {
      assertUsable()
      return deps.isSpeaking()
    },
    subscribe(listener) {
      assertUsable()
      let last = deps.isSpeaking()
      const unsubscribe = deps.subscribe(() => {
        const next = deps.isSpeaking()
        if (next === last) return
        last = next
        try { listener(next) } catch (error) { console.error('[Spindle] TTS listener failed', error) }
      })
      const remove = () => { unsubscribe(); unsubscribers.delete(remove) }
      unsubscribers.add(remove)
      return remove
    },
  }
  // Media revocation and unload stop playback this extension started; host playback keeps going.
  const revoke = () => {
    if ([...owned].some(isCurrent)) deps.stopEngine()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    revoke()
    for (const remove of [...unsubscribers]) remove()
  }
  deps.onTeardown(dispose)
  return { api, revoke, dispose }
}
