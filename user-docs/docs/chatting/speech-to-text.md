---
title: Speech-to-Text
---

# Speech-to-Text

Speech-to-Text (STT) lets you dictate a chat message from the input bar instead of typing it. Lumiverse supports the browser's built-in Web Speech API, local Whistle transcription, and OpenAI-compatible transcription connections such as Whisper.

---

## Setting Up STT

Open **Settings → Voice & Speech → Speech-to-Text** and choose a provider.

| Provider | Best For | Notes |
|----------|----------|-------|
| **Web Speech API** | Fast browser-native dictation | Availability depends on your browser. Chrome and Edge usually work best. The option is greyed out (with "Unavailable") when your browser doesn't support it. |
| **Whistle (on this device)** | Private local dictation without an API key | Prepares automatically from files included with Lumiverse. Audio stays on your device. Supports English, German, French, Spanish, Italian, Dutch, and Polish. |
| **STT Connection** | Whisper and OpenAI-compatible transcription models | Requires an STT connection with an API key and transcription model. |
| **Spindle extension provider** | Extension-specific transcription services | Appears when an enabled extension registers an STT provider and its privileged provider permission has been approved. |

For an STT connection:

1. Open the **Connections** drawer
2. Go to **STT Connections**
3. Click **New STT Connection**
4. Enter a name, API key, and transcription model such as `gpt-4o-transcribe`, `whisper-1`, or your provider's equivalent
5. Return to **Settings → Voice & Speech** and select that connection

!!! tip "OpenAI-compatible endpoints"
    STT connections use OpenAI-compatible `/audio/transcriptions` APIs. Leave **API URL** empty for OpenAI, or enter your proxy/self-hosted endpoint if it implements that route.

Extension-provided STT options may expose different models or requirements. See the extension's own instructions and [Extension-Provided AI Providers](../extensions/index.md#extension-provided-ai-providers).

### Using Whistle

Select **Whistle (on this device)** in Voice & Speech and start dictating with the usual microphone button. There are no keys, accounts, connection profiles, or additional programs to install. Lumiverse prepares Whistle automatically and shows progress. Its roughly 18 MB of files come from your Lumiverse instance and are cached on that device for later use.

Preparation runs in the background while you use the chat. You can speak as soon as the microphone shows **Recording**, even if Whistle is still preparing. Your opening words are retained locally; the completed transcript may take longer to arrive on first use. Microphone permission and device startup must still finish before recording begins.

Choose a supported language or **Detect automatically**. If your previous provider used an unsupported language, Whistle switches to automatic detection. Longer recordings are handled automatically; you can keep speaking past 30 seconds.

Whistle returns completed transcripts instead of live partial words. **Continuous recognition** keeps the mic running across pauses and adds each completed utterance to your dictation. **Auto-submit after silence** ends the session after confirmed speech followed by a sustained pause. You can also click the mic to finish manually, or cancel while Whistle is preparing or processing.

Cached transcription works without downloading the model again. Browser storage limits or clearing site data can remove the cached files; Lumiverse will prepare them again automatically. The local option requires a modern browser with microphone and WebAssembly support, through HTTPS or localhost. Lumiverse automatically uses an alternative audio capture method when the webview cannot use AudioWorklets. Sending the resulting chat message still uses your normal Lumiverse connection.

In Lumiverse Desktop, allow microphone access when prompted. macOS requires the desktop application's microphone usage declaration and audio-input entitlement, and Linux requires its WebKitGTK media settings and permission prompt. Those are included in the desktop shell; an older installed shell must be rebuilt or updated and fully restarted to receive them. Reloading the hosted frontend cannot update native app configuration. Windows uses WebView2's microphone permission prompt and Windows microphone privacy settings.

If Whistle is greyed out, Voice & Speech shows which required capability is missing, even when another STT provider is selected. A microphone capability message means that browser capture is unavailable; it does not mean the model has failed to download.

---

## Voice & Speech Panel Options

The Speech-to-Text section of **Voice & Speech** has several toggles that affect how dictation behaves:

| Setting | What it does |
|---------|--------------|
| **Language** | Recognition language. Whistle offers its seven supported languages and automatic detection. Other providers offer browser locales, including Dutch and Polish. STT connections normalize those locales to the ISO language code Whisper expects. |
| **Continuous recognition** | When on, recognition keeps running across silences instead of stopping at the first pause. Useful for long dictation sessions; pair with the **auto-submit** option below if you want hands-free finishing. |
| **Show interim results** | Displays partial transcriptions in the input bar as you speak. Web Speech only — Whistle and Whisper-style connections return completed transcripts. |
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

For Whistle or STT connections, enable **Auto-submit after silence** if you want Lumiverse to stop recording automatically after you finish speaking.

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

`send message` only works as a command at the end of the completed transcript. Trailing punctuation is allowed, so `Send message.` also works. If you keep speaking afterward, the earlier phrase remains part of the message text. Saying only `send message` can also send text already in the input bar.

This action requires the exact words `send message`; similar phrases such as `sent message` or `send massage` do not trigger it.

### Formatting and Punctuation

| Say | Inserts |
|-----|---------|
| `quote start` | `"` |
| `quote end` | `"` |
| `open quote` | `"` |
| `close quote` | `"` |
| `start quote` or `begin quote` | `"` |
| `end quote` | `"` |
| `single quote` | `'` |
| `apostrophe` | `'` |
| `thought start` | `*` or `**` |
| `begin thought` | `*` or `**` |
| `start thought` | `*` or `**` |
| `thought end` | `*` or `**` |
| `end thought` | `*` or `**` |
| `asterisk` | `*` |
| `em dash` | `—` |

Thought markers nest. The first `thought start` inserts `*`; a second nested thought inserts `**`. Matching `thought end` commands unwind that nesting.

Opening and closing markers attach directly to their contents. Paired `single quote` or `asterisk` commands also attach correctly. Use `apostrophe` for contractions or possessives, such as `it apostrophe s` → `it's` and `James apostrophe book` → `James' book`.

Formatting commands tolerate capitalization, plurals, punctuation between command words, and small transcription errors in words such as `quote`, `thought`, and `asterisk`. For example, `open qoute`, `thoughts start`, and `M dash` are recognized. Action words such as `start`, `end`, `open`, and `close` must still match; this avoids turning ordinary prose such as `thought stars` into formatting. Commands can span recognition results during continuous dictation.

Punctuation after an opening command is ignored. Sentence punctuation after a closing command is placed inside the closing marker, unless the contents already end with sentence punctuation. Other text keeps its punctuation and line breaks.

!!! example
    Saying `thought start I should be careful thought end` becomes `*I should be careful*`.

    Saying `asterisk I open the door asterisk. Open quote Hello close quote.` becomes `*I open the door.* "Hello."`.

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
| Whistle preparation fails | Check your connection to Lumiverse and choose **Try again**, or click the mic again. No external service setup is needed. |
| Whistle is unavailable | Read the reason shown in Voice & Speech. Use HTTPS or localhost, and update/restart an older desktop shell when microphone or browser capabilities are missing. |
| Whistle uses the wrong language | Select your language explicitly instead of automatic detection. Use another provider for languages outside Whistle's seven supported languages. |
| Whisper transcription fails | Verify the STT connection API key, API URL, and model name. |
| Recording stops too soon | Enable **Auto-submit after silence**, or wait a moment after finishing your sentence before stopping manually. |
| Auto-submit never stops | Check for background noise, move closer to the mic, or stop manually. |
