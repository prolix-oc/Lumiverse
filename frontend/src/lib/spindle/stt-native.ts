import { useStore } from '@/store'
import { sttApi } from '@/api/stt'
import { createSTTEngine, getSupportedSTTAudioFormat, isWebSpeechAvailable, type STTConfig } from '../sttEngine'
import { whistleClient } from '../whistle/client'
import { getWhistleRuntimeUnavailableReason, getWhistleUnavailableReason, WHISTLE_LANGUAGES, whistleLanguage } from '../whistle/config'
import { transcribeWhistleAudio } from '../whistle/transcribe'
import { createFrontendSTTAPI, type FrontendSTTDependencies } from './stt-api'
import type { SpindleSTTOptions, SpindleSTTProviderOption } from 'lumiverse-spindle-types'
import { hasIOSNativeBridge } from '../ios-native'
import { isHostCapturing, subscribeHostCapture } from '../sttHostCapture'

export function createNativeSTTAPI(deps: Pick<FrontendSTTDependencies, 'assertActive' | 'requirePermission' | 'onTeardown'>) {
  const getConfig = (): STTConfig => {
    const settings = useStore.getState().voiceSettings
    return {
      provider: settings?.sttProvider ?? 'webspeech', language: settings?.sttLanguage ?? 'en-US',
      continuous: false, interimResults: settings?.sttInterimResults ?? true,
      connectionId: settings?.sttConnectionId,
    }
  }
  const connectionReason = (config: STTConfig) => !config.connectionId ? 'connectionRequired' : undefined
  const microphoneReason = () => typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia
    ? 'microphone' : !getSupportedSTTAudioFormat() ? 'audioCapture' : undefined
  const listProviders = (): SpindleSTTProviderOption[] => {
    const reason = getWhistleUnavailableReason()
    const connection = microphoneReason() ?? connectionReason(getConfig())
    return [
      { id: 'webspeech', name: hasIOSNativeBridge() ? 'Apple Speech Recognition' : 'Web Speech API', onDevice: false, available: isWebSpeechAvailable(),
        ...(!isWebSpeechAvailable() ? { unavailableReason: 'webSpeech' } : {}), supportsAudioTranscription: false },
      { id: 'whistle', name: 'Whistle (on this device)', onDevice: true, available: !reason,
        ...(reason ? { unavailableReason: reason } : {}), supportsAudioTranscription: true, languages: WHISTLE_LANGUAGES },
      { id: 'connection', name: 'STT Connection', onDevice: false, available: !connection,
        ...(connection ? { unavailableReason: connection } : {}), supportsAudioTranscription: true },
    ]
  }
  const validate = (config: STTConfig, capture: boolean) => {
    const reason = config.provider === 'whistle'
      ? (capture ? getWhistleUnavailableReason() : getWhistleRuntimeUnavailableReason())
      : config.provider === 'webspeech' ? (!isWebSpeechAvailable() ? 'webSpeech' : undefined)
        : connectionReason(config) ?? (capture ? microphoneReason() : undefined)
    if (reason) throw new Error(`STT_UNAVAILABLE:${reason}`)
  }
  const prepare = async (config: STTConfig, signal: AbortSignal, onStatus: SpindleSTTOptions['onStatus']) => {
    validate(config, false)
    if (config.provider !== 'whistle') return
    const unsubscribe = whistleClient.subscribe(() => {
      if (!signal.aborted) {
        const state = whistleClient.getState()
        if (state.phase === 'loading') onStatus?.({ phase: 'loading', progress: state.progress })
      }
    })
    signal.addEventListener('abort', unsubscribe, { once: true })
    try { await whistleClient.prepare() }
    finally { unsubscribe(); signal.removeEventListener('abort', unsubscribe) }
  }
  return createFrontendSTTAPI({
    ...deps, getConfig, listProviders, prepare, isHostCapturing, subscribeHostCapture,
    createEngine(config) { validate(config, true); return createSTTEngine(config) },
    async transcribe(audio, config, signal, onStatus, { keywords, words }) {
      validate(config, false)
      if (config.provider === 'webspeech') throw new Error('STT_AUDIO_UNSUPPORTED: Web Speech requires microphone capture')
      await prepare(config, signal, onStatus)
      if (signal.aborted) throw new DOMException('Transcription cancelled', 'AbortError')
      onStatus?.({ phase: 'processing' })
      if (config.provider === 'whistle') {
        const { words: wordList, ...result } = await transcribeWhistleAudio(audio, whistleLanguage(config.language), whistleClient, signal, keywords)
        return { ...result, provider: 'whistle', ...(words ? { words: wordList } : {}) }
      }
      if (!(audio instanceof Blob)) throw new Error('STT_AUDIO_UNSUPPORTED: STT connections require an audio Blob')
      const extension = {
        'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
        'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
      }[audio.type.split(';')[0]] ?? 'webm'
      const fileName = typeof File !== 'undefined' && audio instanceof File && audio.name
        ? audio.name : `recording.${extension}`
      // STT connections ignore keywords and return no word list.
      const result = await sttApi.transcribe(audio, { language: config.language, connectionId: config.connectionId!, fileName, signal })
      return { ...result, provider: 'connection' }
    },
  })
}
