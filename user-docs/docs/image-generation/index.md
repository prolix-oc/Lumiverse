# Image Generation

Lumiverse can generate images based on your conversation, creating visual scene illustrations that update as the story progresses.

---

## How It Works

1. A sidecar LLM analyzes the current scene in your chat
2. It extracts scene data: environment, time of day, weather, mood, and focal details
3. If the scene has changed significantly (or you force it), an image is generated
4. The image appears as the chat background or in the image panel

The system is designed to be hands-off — it watches the conversation and generates new backgrounds when the setting changes.

---

## Scene Data

The scene analysis extracts:

| Field | Description |
|-------|-------------|
| **Environment** | The setting/location (e.g., "dimly lit tavern," "moonlit garden") |
| **Time of Day** | When the scene takes place |
| **Weather** | Atmospheric conditions |
| **Mood** | Emotional tone of the scene |
| **Focal Detail** | A specific element to focus on |
| **Palette Override** | Optional color scheme suggestion |

A new image is generated when the scene data changes beyond the **scene change threshold** — a configurable sensitivity for how much needs to change before triggering regeneration.

---

## Supported Providers

| Provider | Style |
|----------|-------|
| **Google Gemini** | General-purpose image generation |
| **NanoGPT** | Access to multiple image models via API |
| **NovelAI** | Anime/illustration style with Danbooru tag support |

---

## Quick Links

- [Setup & Providers](setup.md) — Configure image generation connections
