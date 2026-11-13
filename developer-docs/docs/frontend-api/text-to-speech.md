# Text-to-speech

`ctx.tts` plays speech through Lumiverse's TTS stack: the user's TTS connections,
voices, volume and speed from Voice & Speech, and the same audio engine as chat.
It also tells extensions when host TTS is playing, so an extension that listens
to the microphone can pause while Lumiverse speaks.

## Availability and permission

Feature-detect `ctx.tts` and `ctx.host.capabilities['text-to-speech-v1'] >= 1`.

Declare `"media"` in `spindle.json`. `speak()` and `stop()` require it.
`isSpeaking()` and `subscribe()` are free.

Extensions control their own speech enablement. Offer an extension setting for
automatic speech, or start it from an explicit playback action. The general
chat **Enable text-to-speech** and **Auto-play responses** settings do not gate
`ctx.tts.speak()` calls, including message playback. Shared volume, speed, voice
selection and message speech-detection rules still apply; extension calls do
not change the user's chat settings.

```ts
const tts = ctx.tts
if (!tts || (ctx.host.capabilities['text-to-speech-v1'] ?? 0) < 1) return

// Pause the microphone while any host TTS plays, including chat auto-play.
const unsubscribe = tts.subscribe((speaking) => {
  if (speaking) pauseListening()
  else resumeListening()
})

try {
  await tts.speak({ text: 'Opening your world books.' })
} catch (error) {
  showError(error)
}

// Read a chat message with the host's per-character voices.
await tts.speak({ messageId: ctx.messages.getLatestMessageId()! })
```

## API

| Method | Permission | Behavior |
| --- | --- | --- |
| `speak({ text }, { connectionId? })` | `media` | Speaks the text as given, with the connection's default voice. `connectionId` defaults to the user's TTS connection (Voice & Speech, else the default TTS profile). Nothing is saved. |
| `speak({ messageId })` | `media` | Plays a message of the active chat like its Play button: the saved audio when the message has it, otherwise the host voice pipeline (per-character voices, narration rules). That pipeline saves the audio to the message, as the Play button does. |
| `stop()` | `media` | Stops all host TTS playback: the audio engine, saved message audio, and pending chat auto-play. |
| `isSpeaking()` | Free | `true` while any host TTS audio plays or is being prepared for playback. |
| `subscribe(listener)` | Free | Calls `listener(speaking)` when host TTS playback starts or stops. Returns an unsubscribe function. |

`speak()` first stops current host TTS playback. It resolves when this playback
ends, or when it is stopped or replaced by other playback. It rejects when it
cannot start or when synthesis fails:

| Error | Cause |
| --- | --- |
| `TTS_INPUT_INVALID` | Neither a non-empty `text` nor a `messageId`, or `connectionId` with `messageId` |
| `TTS_UNAVAILABLE:disabled` | Older hosts gated extensions on the chat TTS switch; update Lumiverse for independent extension playback |
| `TTS_UNAVAILABLE:connectionRequired` | No TTS connection is selected or marked default |
| `TTS_CONNECTION_NOT_FOUND` | `connectionId` is not one of the user's TTS connections |
| `TTS_MESSAGE_NOT_FOUND` | The message is not in the active chat |
| `TTS_NOTHING_TO_SPEAK` | The message has no voice or no speakable text |
| `TTS_AUDIO_LOAD_FAILED` | The saved message audio could not be fetched |

List TTS connections with `ctx.connections.list({ kind: 'tts' })` where the host
supports `connection-kinds-v1`.

## Cleanup

Unload, reload and `media` permission revocation stop playback that the
extension started. Playback started by the user or by chat auto-play keeps
going. Unload also removes the extension's `subscribe()` listeners.
