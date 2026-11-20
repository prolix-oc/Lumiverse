import { useStore } from '@/store'
import {
  getPlaybackSession, isSpeaking, isTTSPlaybackActive, stop, stopAllTTSPlayback, subscribeTTSPlayback,
} from '../ttsAudio'
import { playSavedMessageAudio, startMessageTtsPlaybackSession, startTextTtsPlayback } from '../ttsMessagePlayback'
import { resolveTtsConnectionId } from '../voiceResolution'
import { createFrontendTTSAPI, type FrontendTTSDependencies } from './tts-api'

export function createNativeTTSAPI(deps: Pick<FrontendTTSDependencies, 'assertActive' | 'requirePermission' | 'onTeardown'>) {
  const start: FrontendTTSDependencies['start'] = (input, options) => {
    const state = useStore.getState()
    // An explicit, Media-authorized extension request has its own opt-in.
    // The chat-reading toggle must not disable an extension's speech controls.
    if ('messageId' in input) {
      const message = state.messages.find((candidate) => candidate.id === input.messageId)
      if (!message) throw new Error('TTS_MESSAGE_NOT_FOUND: the message is not in the active chat')
      // Same choice as the message's Play button: saved audio first, else the voice pipeline.
      const attachments = Array.isArray(message.extra?.attachments) ? message.extra.attachments : []
      const saved = attachments.find((attachment) => attachment?.type === 'audio'
        && (attachment.swipe_id === undefined || attachment.swipe_id === message.swipe_id))
      if (saved?.image_id) {
        const controller = new AbortController()
        const synthesized = playSavedMessageAudio(message.id, saved.image_id, controller.signal)
        return { session: getPlaybackSession(), synthesized, cancel: () => controller.abort() }
      }
      const playback = startMessageTtsPlaybackSession({
        messageId: message.id, messageName: message.name, messageContent: message.content, messageIsUser: message.is_user,
      }, { enabled: true })
      if (!playback) throw new Error('TTS_NOTHING_TO_SPEAK: no voice or no speakable text for this message')
      return { session: getPlaybackSession(), ...playback }
    }
    const connectionId = options.connectionId ?? resolveTtsConnectionId(state.voiceSettings, state.ttsProfiles)
    if (!connectionId) throw new Error('TTS_UNAVAILABLE:connectionRequired')
    if (!state.ttsProfiles.some((profile) => profile.id === connectionId)) throw new Error('TTS_CONNECTION_NOT_FOUND')
    const controller = new AbortController()
    const synthesized = startTextTtsPlayback({ text: input.text, connectionId, signal: controller.signal })
    return { session: getPlaybackSession(), synthesized, cancel: () => controller.abort() }
  }
  return createFrontendTTSAPI({
    ...deps,
    start,
    isSpeaking: isTTSPlaybackActive,
    isEngineSpeaking: isSpeaking,
    getSession: getPlaybackSession,
    subscribe: subscribeTTSPlayback,
    stopEngine: stop,
    stopAll: stopAllTTSPlayback,
  })
}
