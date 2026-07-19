---
title: Image Generation
---

# Image Generation

Lumiverse generates scene illustrations, character shots, and chat attachments from your conversations. It can run a hands-off **Scene tool** that watches your chat and refreshes the background as the setting shifts, or accept a **custom prompt** you write yourself — with full preset and macro support.

---

## What's New

The image generation system was substantially rebuilt. If you used Lumiverse before this release, the parts you'll notice first:

- **Three prompt modes** — _Scene tool_, _Custom prompt_, and _Chat-aware custom_ (your instructions, but applied to the live chat context by a parser LLM).
- **Prompt presets** with per-character and per-persona **bindings** — splice character or persona snippets into a main preset with `{{character_prompt}}` / `{{persona_prompt}}`.
- **Output targets** — send the result to the chat background, insert it as a new chat image, or attach it to the most recent message.
- **Prompt preview** — see (and optionally edit) the resolved prompt before the image provider is called.
- **Six providers** — ComfyUI and SwarmUI for local generation, plus Google Gemini, NovelAI, NanoGPT, and Pollinations in the cloud.
- **Configurable timeouts** — separate limits for the parser/scene LLM and for the image provider itself.
- **Gallery integration** — generated images can be auto-added to the active character's gallery and (optionally) re-sent to the LLM as multimodal context.

---

## How It Works

1. You pick a **prompt mode** — Scene tool, Custom, or Chat-aware Custom.
2. Lumiverse builds the final prompt (running the parser/scene LLM if needed and substituting any character / persona snippets).
3. The active **image-gen connection** generates the image.
4. The result is routed to the **output target** you chose — background, new chat image, or attached to the last message — and optionally linked into the character gallery.

In Scene mode the cycle is automatic: each new reply is checked against the previous scene, and a new image is generated only when enough fields have changed (you control the sensitivity). In Custom and Chat-aware modes you trigger generation yourself with the **Generate** button.

---

## Prompt Modes

| Mode | What it does |
|------|--------------|
| **Scene tool** | A sidecar LLM reads the chat and extracts a structured scene (environment, time of day, weather, mood, focal detail, and — optionally — visible characters and composition). The provider-specific prompt is built from those fields. |
| **Custom prompt** | Your prompt is sent to the image provider verbatim. Macros (`{{user}}`, `{{char}}`, `{{character_prompt}}`, `{{persona_prompt}}`, …) are still resolved. |
| **Chat-aware custom** | Your text becomes _parser instructions_, not the final prompt. A parser LLM rewrites the current chat context into an image prompt following your guidance. |

See [Prompts & Presets](prompts-and-presets.md) for the full picture, including how to save presets and bind them to a character or persona.

---

## Output Targets

| Target | Result |
|--------|--------|
| **Set as background** | Image becomes the chat background at your configured opacity. |
| **Insert into chat** | A new chat message is created with the image as an attachment. |
| **Attach to last message** | The image is appended to the most recent message's attachments. |
| **Preview only** | The image is generated but not placed in the chat — useful for testing a preset. |

Generated images are persisted with thumbnails and a public URL, are addressable from the image gallery, and (when enabled) are automatically linked into the active character's gallery.

---

## Providers At a Glance

| Provider | Runs | Strength |
|----------|------|----------|
| **ComfyUI** | Local | Bring-your-own workflow. Full control over samplers, schedulers, checkpoints, and any custom node graph you've already built. |
| **SwarmUI** | Local | Friendlier wrapper around Comfy with built-in model browsing and component overrides (VAE, text encoders). |
| **Google Gemini** | Cloud | Prose prompts, multiple aspect ratios, up to 4K. |
| **NovelAI** | Cloud | Anime/illustration with Danbooru-style tags and **director reference images** (character / persona avatars or your own uploads). |
| **NanoGPT** | Cloud | Aggregator — access to Flux, HiDream, DALL·E 3, Imagen 4, Midjourney, Recraft, SDXL, SD 3.5, Reve, and others under one key. |
| **Pollinations** | Cloud | Lightweight provider with optional `enhance`, transparency, and quality tiers. |

See [Setup & Providers](setup.md) for connection setup and per-provider quirks.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Setup & Providers](setup.md) | Create an image-gen connection and configure each provider (including importing a ComfyUI workflow). |
| [Prompts & Presets](prompts-and-presets.md) | Use Scene / Custom / Chat-aware modes, save presets, bind them to a character or persona, and preview the resolved prompt. |
| [Scene, Output & Timeouts](scene-and-output.md) | Configure scene detection, output targets, gallery and context recycling, timeouts, and background display. |
