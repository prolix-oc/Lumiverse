---
title: Text-to-Speech
---

# Text-to-Speech

Lumiverse can speak assistant replies aloud using a configurable text-to-speech connection. You can play any message manually, or have new replies auto-play as they finish generating.

---

## Setting Up TTS

1. Open the **Connections** drawer.
2. Switch to **TTS Connections** and click **New TTS Connection**.
3. Pick a **Provider** (see below).
4. Enter the **API URL** (only needed for self-hosted endpoints; leave blank for the provider default) and any required **API Key**.
5. Choose a **Model** and **Voice**. Use the refresh button on each field to fetch live lists where the provider supports it.
6. Optionally adjust provider-specific parameters (stability, style, output format, …).
7. Save, then click **Test** to confirm the connection.

Once a connection exists, open **Settings → Voice & Speech** and turn on **Enable text-to-speech**. Playback uses the TTS connection marked as default unless you select another connection from the dropdown. Narration and speech use that connection's saved voice unless you set a narrator, character, or chat voice override.

---

## Providers

The built-in providers are listed below. Enabled [Spindle extensions](../extensions/index.md#extension-provided-ai-providers) can also register TTS providers; those appear in Lumiverse's voice provider and connection selectors after an operator approves the extension's privileged provider permission.

### OpenAI TTS

- **API key:** Required.
- **Default URL:** `https://api.openai.com/v1`. Override to use a proxy.
- **Voices:** Built-in (Alloy, Ash, Ballad, Cedar, Coral, Echo, Fable, Marin, Nova, Onyx, Sage, Shimmer, Verse).
- **Models:** Fetched live from your account.
- **Parameters:** `speed` (0.25 – 4.0) and `instructions` (style guidance, e.g. _"Speak warmly with a slight British accent"_ — only honored by `gpt-4o-mini-tts`).
- **Streaming:** Supported. Lumiverse buffers the stream and plays it as a single clip.
- **Output formats:** MP3, Opus, AAC, FLAC, WAV, PCM (default: MP3).

### OpenRouter TTS

- **API key:** Required — your OpenRouter API key.
- **Default URL:** `https://openrouter.ai/api/v1`.
- **Models:** Fetched live using OpenRouter's speech-output filter.
- **Voices:** Model-specific; choose a listed voice or enter the model's voice ID.
- **Output formats:** Gemini models automatically request PCM, even when MP3 is configured. Lumiverse wraps the PCM as WAV for browser playback. Other models default to MP3 and also support PCM.
- **Streaming:** Supported. PCM responses are buffered and receive one WAV header before playback.

### ElevenLabs

- **API key:** Required (sent as `xi-api-key`).
- **Default URL:** `https://api.elevenlabs.io`.
- **Voices:** Fetched live from your ElevenLabs account, including any custom voices you've created.
- **Models:** Eleven v3 (Most Expressive), Eleven Multilingual v2, Eleven Flash v2.5 (Low Latency).
- **Parameters:**

    | Field | Default | Range |
    |-------|---------|-------|
    | `stability` | 0.5 | 0 – 1. Higher = more consistent, lower = more expressive. |
    | `similarity_boost` | 0.75 | 0 – 1. How closely the synth matches the original voice clone. |
    | `style` | 0 | 0 – 1. Amplifies voice style; available in Advanced. |
    | `speed` | 1.0 | 0.7 – 1.2 (ElevenLabs caps narrower than OpenAI). |
    | `use_speaker_boost` | On | Enhances clarity. |
    | `language_code` | (auto) | Force a language code (`en`, `ja`, `de`, …) or leave blank for auto-detect. |
    | `output_format` | `mp3_44100_128` | Wide list including MP3 22–192 kbps, PCM 16–44 kHz, and µ-law 8 kHz. |

- **Streaming:** Supported.

### Google AI Studio TTS

- **API key:** Required — plain API key, same as the Gemini text connection.
- **Default URL:** `https://generativelanguage.googleapis.com`.
- **Voices:** 30 mapped prebuilt voices (e.g. Kore, Charon, Puck, Zephyr, Fenrir, Leda), each with gender labels.
- **Models:** Fetched live and filtered to TTS/speech models (currently `gemini-3.1-flash-tts-preview`, `gemini-2.5-pro-preview-tts`, `gemini-2.5-flash-preview-tts`), with a static fallback when the API is unreachable.
- **Parameters:** `language_code` (optional BCP-47 code) and `temperature` (voice variation).
- **Output format:** WAV (Gemini returns raw PCM; Lumiverse wraps it so browsers can play it).
- **Streaming:** Supported.

### Google Vertex TTS

- **Credentials:** Required — upload your Google Cloud service account key JSON file (or paste it), same as the Vertex text connection.
- **Region:** Choose your Google Cloud region (e.g. `us-central1` or `global`), matching the Vertex text connection profile.
- **Voices:** Same 30 mapped prebuilt voices as AI Studio TTS.
- **Models:** Same live-filtered TTS list with static fallback.
- **Parameters:** Same as AI Studio TTS.
- **Output format:** WAV.
- **Streaming:** Supported.

### Kokoro TTS (self-hosted)

- **API key:** Not required — Kokoro is a local server.
- **Default URL:** `http://localhost:8880/v1`. Point at wherever you've run Kokoro-FastAPI (or any compatible server).
- **Voices:** Built-in catalog of 50+ voices across American/British English, Japanese, Mandarin, Spanish, French, Hindi, Italian, and Brazilian Portuguese. Voice IDs use a `language+gender` prefix (`af_` American Female, `bm_` British Male, `jf_` Japanese Female, etc.).
- **Models:** Static — Kokoro ships a single model id (`kokoro`).
- **Parameters:** `speed` (0.5 – 2.0).
- **Streaming:** Supported.
- **Output formats:** MP3, Opus, WAV, FLAC.

!!! tip "Kokoro is OpenAI-compatible"
    Kokoro inherits Lumiverse's OpenAI-compatible TTS plumbing, so any other OpenAI-compatible TTS server you have running can be reached by creating a Kokoro connection and pointing the API URL at it.

### OpenVox TTS (self-hosted)

- **API key:** Not required — OpenVox runs locally.
- **Default URL:** `http://127.0.0.1:8000/v1`.
- **Models:** Fetched from OpenVox with `GET /models`.
- **Voices:** Fetched after a model is selected from `GET /models/{model}/voices`.
- **Language:** Defaults to English (`en`) for synthesis.
- **Output format:** WAV.
- **Streaming:** Lumiverse currently uses OpenVox's buffered speech response.

---

## Playing Audio

### Auto-play

In **Settings → Voice & Speech**, enable **Auto-play responses** to speak every new assistant reply as soon as generation finishes. Auto-play respects whatever **Speech detection** rules you've configured (see below) — segments marked as _Skip_ are filtered out before synthesis.

### Manual playback

When a message is on screen, use the speaker control on the bubble to play (or stop) that message at any time. The **Test** button in Voice settings synthesizes a short sample using your current connection, speed, and volume — useful when tuning a voice without sending a real message.

### Speed & Volume

| Setting | Default | Range |
|---------|---------|-------|
| **Speed** | 1.0× | 0.5 – 2.0× (in 0.1 steps) |
| **Volume** | 100% | 0 – 100% (in 5% steps) |

Speed and volume apply on top of any provider-side speed parameter — they control the audio element after playback starts.

---

## Speech Detection Rules

Roleplay messages mix dialogue, narration, and inner thoughts. Speech Detection lets you decide what to do with each segment when synthesizing. Lumiverse parses messages into segments by formatting:

- `"quoted text"` → **Quoted**
- `*asterisked text*` → **Asterisked**
- Everything else → **Undecorated**

Each segment type has its own playback rule under **Voice & Speech → Speech Detection**.

| Segment | Choices | Default | When to use it |
|---------|---------|---------|----------------|
| **Asterisked** | _Skip (Thought)_ · _Read as Narration_ | Skip | Skip if you write `*` as inner thoughts. Switch to Narration if your style uses asterisks for stage directions. |
| **Quoted** | _Read as Speech_ · _Read as Narration_ · _Skip_ | Speech | Default keeps dialogue voiced; switch to Skip if you only want narration spoken. |
| **Undecorated** | _Read as Narration_ · _Read as Speech_ · _Skip_ | Narration | Use Speech mode for chat-style messages without quotation marks. Use Skip if you only want explicitly quoted dialogue voiced. |

The segments tagged _Skip_ are dropped before the request hits the provider, which keeps you from paying for tokens you'd never hear.

!!! tip "Mismatched delimiters fall back gracefully"
    An unmatched `*` or `"` is treated as plain text rather than swallowing the rest of the message. You can mix styles freely without breaking detection.

---

## Tips

!!! tip "Use Flash v2.5 for auto-play"
    On ElevenLabs, the Multilingual v2 model is the most accurate but slow enough that auto-play feels laggy on short replies. Flash v2.5 trades some expressiveness for near-instant synthesis — well worth it for chat-style use.

!!! tip "Kokoro doubles as your free local fallback"
    Running Kokoro locally costs nothing per request and ships dozens of voices. If you stream TTS for hours of chat, point auto-play at Kokoro and reserve cloud providers for manual playback of important scenes.

!!! warning "Browser audio focus rules apply"
    Some browsers block audio until the user has interacted with the page. If auto-play silently does nothing right after a hard reload, click anywhere in the chat once and try again.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| **Test button is disabled** | Mark a TTS connection as default or pick one in **Voice & Speech**. |
| **"TTS error 401" on test** | API key is missing or invalid for that provider's connection. |
| **Auto-play fires but no sound** | Volume slider is at 0%, the OS is muted, or the browser has tab audio blocked. |
| **Kokoro returns 5xx** | The local server is unreachable — confirm the API URL and that the container is running. |
| **ElevenLabs voices list is empty** | Your account has no voices visible — open the ElevenLabs dashboard, ensure at least one voice is enabled, then click the refresh button on the Voice field. |
| **OpenAI `instructions` field is ignored** | Only `gpt-4o-mini-tts` honors style instructions. Switch models or remove the field. |
