export const WHISTLE_SAMPLE_RATE = 16000
export const WHISTLE_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'] as const
export const WHISTLE_CACHE = 'lumiverse-whistle-b6e02f048568-c19b9ddf9c7d'

// Assets ship with the frontend; no third-party service is contacted at runtime.
export const WHISTLE_ASSETS = {
  wasm: {
    path: 'stt/whistle/needle-c19b9ddf9c7d.wasm',
    bytes: 903655,
    sha256: 'c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d',
  },
  model: {
    path: 'stt/whistle/whistle-b6e02f048568.cact',
    bytes: 16919407,
    sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  },
} as const

export function whistleLanguage(locale: string): string | undefined {
  const language = locale.trim().toLowerCase().split(/[-_]/)[0]
  return (WHISTLE_LANGUAGES as readonly string[]).includes(language) ? language : undefined
}

export type WhistleUnavailableReason = 'secureContext' | 'worker' | 'wasm' | 'crypto' | 'microphone' | 'audioCapture'

/** Runtime prerequisites also apply to supplied audio, which needs no microphone. */
export function getWhistleRuntimeUnavailableReason(): WhistleUnavailableReason | undefined {
  if (typeof window === 'undefined' || window.isSecureContext === false) return 'secureContext'
  if (typeof Worker === 'undefined') return 'worker'
  if (typeof WebAssembly === 'undefined' || typeof BigInt === 'undefined') return 'wasm'
  if (!globalThis.crypto?.subtle) return 'crypto'
  return undefined
}

/** Check actual APIs rather than a browser name: embedded webviews vary with the OS. */
export function getWhistleUnavailableReason(): WhistleUnavailableReason | undefined {
  const runtimeReason = getWhistleRuntimeUnavailableReason()
  if (runtimeReason) return runtimeReason
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'microphone'
  const Context = window.AudioContext || (window as any).webkitAudioContext
  if (!Context || (typeof AudioWorkletNode === 'undefined' && typeof Context.prototype?.createScriptProcessor !== 'function')) {
    return 'audioCapture'
  }
  return undefined
}

export function isWhistleAvailable(): boolean {
  return getWhistleUnavailableReason() === undefined
}

export interface WhistleWord {
  word: string
  start: number
  end: number
  probability: number
}

export interface WhistleTranscript {
  text: string
  language: string
  words: WhistleWord[]
}

export type WhistleRequest =
  | { type: 'prepare'; id: number }
  | { type: 'transcribe'; id: number; pcm: Float32Array; language?: string; keywords?: readonly string[] }

export type WhistleResponse =
  | { type: 'progress'; progress: number }
  | { type: 'ready'; id: number }
  | { type: 'result'; id: number; result: WhistleTranscript }
  | { type: 'error'; id: number; error: string }

export type WhistleState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  progress: number
  error?: string
}
