# Speech-to-Text

Speech-to-Text (STT) lets you dictate a chat message from the input bar instead of typing it. Lumiverse supports the browser's built-in Web Speech API and OpenAI-compatible transcription connections such as Whisper.

---

## Setting Up STT

Open **Settings → Voice & Speech → Speech-to-Text** and choose a provider.

| Provider | Best For | Notes |
|----------|----------|-------|
| **Web Speech API** | Fast browser-native dictation | Availability depends on your browser. Chrome and Edge usually work best. The option is greyed out (with "Unavailable") when your browser doesn't support it. |
| **STT Connection** | Whisper and OpenAI-compatible transcription models | Requires an STT connection with an API key and transcription model. |

For an STT connection:

1. Open the **Connections** drawer
2. Go to **STT Connections**
3. Click **New STT Connection**
4. Enter a name, API key, and transcription model such as `gpt-4o-transcribe`, `whisper-1`, or your provider's equivalent
5. Return to **Settings → Voice & Speech** and select that connection

!!! tip "OpenAI-compatible endpoints"
    STT connections use OpenAI-compatible `/audio/transcriptions` APIs. Leave **API URL** empty for OpenAI, or enter your proxy/self-hosted endpoint if it implements that route.

---

## Voice & Speech Panel Options

The Speech-to-Text section of **Voice & Speech** has several toggles that affect how dictation behaves:

| Setting | What it does |
|---------|--------------|
| **Language** | Recognition language. Eleven locales are built in: English (US/UK), Japanese, Mandarin (Simplified), Spanish, French, German, Italian, Brazilian Portuguese, Korean, and Russian. For STT-connection providers, Lumiverse also normalizes the locale to the ISO country code Whisper expects. |
| **Continuous recognition** | When on, recognition keeps running across silences instead of stopping at the first pause. Useful for long dictation sessions; pair with the **auto-submit** option below if you want hands-free finishing. |
| **Show interim results** | Displays partial transcriptions in the input bar as you speak. Web Speech only — Whisper-style connections only return the final transcript. |
| **Auto-submit after silence** | Decides the recording is finished after a sustained pause and either dispatches it (Web Speech) or sends it for transcription (STT connections). See [Auto-Submit After Silence](#auto-submit-after-silence) below. |
| **Show mic button in input bar** | Toggles the microphone shortcut shown next to the message input. Turn it off if you only use the keyboard. |

---

## Dictating a Message

1. Open a chat
2. Click the **microphone** button in the input bar
3. Speak your message
4. Click the microphone again to finish, or use auto-submit after silence if enabled

When transcription finishes, Lumiverse places the dictated text into the chat flow.

By default, a completed STT transcript is queued as a user message. If you want Lumiverse to send it immediately and start generation, end your dictation with `send message`.

!!! example
    Saying `I gently open the door send message` sends `I gently open the door` immediately.

---

## Auto-Submit After Silence

For STT connections, enable **Auto-submit after silence** if you want Lumiverse to stop recording automatically after you finish speaking.

This is useful for Whisper-style providers because they do not stream interim words back to the browser. Lumiverse listens for confirmed speech, then waits for a sustained pause before sending the audio to transcription.

Use this when:

- You want hands-free dictation
- Your messages were being cut off by stopping the mic too early
- You prefer Lumiverse to decide when the utterance is complete

Leave it off when:

- You want full manual control over when recording ends
- You often pause for long stretches while thinking mid-sentence
- Your microphone or room noise makes silence detection unreliable

!!! note "Silence detection happens before transcription"
    Whisper receives one completed audio recording. The silence detector decides when that recording is complete; Whisper then transcribes the whole clip.

---

## Command Words

Lumiverse recognizes a small set of spoken commands while normalizing STT transcripts.

### Message Action

| Say | Result |
|-----|--------|
| `send message` at the end | Sends the dictated message immediately instead of only queueing it |

`send message` only works as a command at the end of the transcript. If you say it in the middle, it remains part of the message text.

### Formatting and Punctuation

| Say | Inserts |
|-----|---------|
| `quote start` | `"` |
| `quote end` | `"` |
| `open quote` | `"` |
| `close quote` | `"` |
| `single quote` | `'` |
| `apostrophe` | `'` |
| `thought start` | `*` or `**` |
| `begin thought` | `*` or `**` |
| `thought end` | `*` or `**` |
| `end thought` | `*` or `**` |
| `asterisk` | `*` |
| `em dash` | `—` |

Thought markers nest. The first `thought start` inserts `*`; a second nested thought inserts `**`. Matching `thought end` commands unwind that nesting.

!!! example
    Saying `thought start I should be careful thought end` becomes `*I should be careful*`.

---

## Tips for Better Transcription

- Speak a little past your final word before stopping the mic manually.
- Use **Auto-submit after silence** for Whisper/STT connections if you frequently clip the end of messages.
- Keep the microphone close enough that speech is clearly louder than room noise.
- If auto-submit triggers too early, turn it off and stop the recording manually.
- Use `send message` only when you are sure the dictated message should start generation immediately.

---

## Troubleshooting

| Problem | What to Try |
|---------|-------------|
| The microphone button is disabled | Check browser microphone permissions and make sure your selected STT provider is available. |
| Web Speech is unavailable | Switch to an STT connection, or use a browser with Web Speech support. |
| Whisper transcription fails | Verify the STT connection API key, API URL, and model name. |
| Recording stops too soon | Enable **Auto-submit after silence**, or wait a moment after finishing your sentence before stopping manually. |
| Auto-submit never stops | Check for background noise, move closer to the mic, or stop manually. |
