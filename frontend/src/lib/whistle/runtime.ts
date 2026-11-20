import createNeedle from './vendor/needle.js'
import { WHISTLE_SAMPLE_RATE, whistleLanguage, type WhistleTranscript } from './config'

interface NeedleModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  _needle_load(pointer: number, bytes: bigint): number
  _needle_models(): number
  _needle_last_error(): number
  _needle_transcribe(pcm: number, samples: number, language: number, keywords: number,
    timestamps: number, output: number, capacity: number): number
  UTF8ToString(pointer: number): string
}

export class WhistleRuntime {
  private constructor(private module: NeedleModule) {}

  static async load(wasm: Uint8Array, model: Uint8Array): Promise<WhistleRuntime> {
    const factory = createNeedle as unknown as (options: { wasmBinary: Uint8Array }) => Promise<NeedleModule>
    const module = await factory({ wasmBinary: wasm })
    const pointer = module._malloc(model.length)
    if (!pointer) throw new Error('There is not enough memory to prepare Whistle on this device.')
    try {
      module.HEAPU8.set(model, pointer)
      if (module._needle_load(pointer, BigInt(model.length)) < 0 || module._needle_models() !== 2) {
        throw new Error(module.UTF8ToString(module._needle_last_error()) || 'Whistle could not load its speech model.')
      }
    } finally { module._free(pointer) }
    return new WhistleRuntime(module)
  }

  /** Keywords bias recognition toward names and terms; the engine takes them newline-separated. */
  transcribe(pcm: Float32Array, language?: string, keywords?: readonly string[]): WhistleTranscript {
    if (!pcm.length) return { text: '', language: '', words: [] }
    if (pcm.length > WHISTLE_SAMPLE_RATE * 30) throw new Error('Whistle audio windows must be at most 30 seconds.')
    if (language && !whistleLanguage(language)) throw new Error('This language is not supported by Whistle.')
    const module = this.module
    const pointers: number[] = []
    const allocate = (size: number) => {
      const pointer = module._malloc(size)
      if (!pointer) throw new Error('There is not enough memory to transcribe on this device.')
      pointers.push(pointer)
      return pointer
    }
    try {
      const input = allocate(pcm.byteLength)
      const capacity = 1 << 18
      const output = allocate(capacity)
      const string = (value: string | undefined) => {
        if (!value) return 0
        const bytes = new TextEncoder().encode(value + '\0')
        const pointer = allocate(bytes.length)
        module.HEAPU8.set(bytes, pointer)
        return pointer
      }
      const languagePointer = string(language && whistleLanguage(language))
      const keywordsPointer = string(keywords?.join('\n'))
      new Float32Array(module.HEAPU8.buffer, input, pcm.length).set(pcm)
      const code = module._needle_transcribe(input, pcm.length, languagePointer, keywordsPointer, 1, output, capacity)
      if (code < 0) throw new Error(module.UTF8ToString(module._needle_last_error()) || 'Whistle transcription failed.')
      const result = JSON.parse(module.UTF8ToString(output)) as WhistleTranscript
      if (typeof result.text !== 'string' || typeof result.language !== 'string') throw new Error('Whistle returned an invalid transcript.')
      // The native silence fast path omits words even when timestamps were requested.
      if (!result.text.trim()) return { text: '', language: result.language, words: [] }
      if (!Array.isArray(result.words) || !result.words.length || result.words.some((word) =>
        typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end < word.start || word.end > pcm.length / WHISTLE_SAMPLE_RATE + 0.1)) {
        throw new Error('Whistle returned invalid word timestamps.')
      }
      return result
    } finally {
      for (const pointer of pointers.reverse()) module._free(pointer)
    }
  }
}
