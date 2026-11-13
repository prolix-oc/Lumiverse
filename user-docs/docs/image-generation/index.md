---
title: Image Generation
---

# Image Generation

Lumiverse generates scene illustrations, character shots, and chat attachments from your conversations. It can run a hands-off **Scene tool** that watches your chat and refreshes the background as the setting shifts, or accept a **custom prompt** you write yourself — with full preset and macro support.

---

## Finding the controls

Open **Image Gen** in the sidebar. The drawer keeps the choices for your next generation together: connection, mode, output, active main prompt preset (in Custom or Chat-aware Custom mode), active LoRA preset, and **Quick Behavior**. Progress, the last scene, previews, **Generate Now**, and **Force Generate** stay here too.

Deep editing opens in a modal:

| Entry point | What it contains |
|-------------|------------------|
| **Edit** beside the prompt preset / **Prompt Studio…** in Scene mode | Main, Character, and Persona preset editors, a shared Parser tab, and separate Captioning preset/parser controls. |
| **Edit** beside the LoRA preset | **LoRA Studio**: ordered LoRA rows, strengths, base tags, preset save/delete, bypass controls, and strength scale. |
| **Configure Generation…** | **Generation Settings**: provider parameters and models, source images where supported, automation, background display, and timeouts. |
| **Caption Image** | Upload an image to generate descriptive tags with the existing captioner. |
| **Export / Import** | Import or export image-generation configuration from the centered utility row beside **Caption Image**. Available even while image generation is disabled. |

**Done** closes an editor. Provider parameters and behavior settings persist as you change them; Done does not perform a separate save. Prompt and LoRA presets have their own explicit save actions. Closing and reopening a studio while the drawer remains mounted preserves its current draft.

---

## How It Works

1. You pick a **prompt mode** — Scene tool, Custom, or Chat-aware Custom.
2. Lumiverse builds the final prompt (running the parser/scene LLM if needed and substituting any character / persona snippets).
3. The active **image-gen connection** generates the image.
4. The result is routed to the **output target** you chose — background, new chat image, or attached to the last message — and optionally linked into the character gallery.

**Auto-Generate On Reply** triggers generation after replies using the selected mode. In Scene mode, the scene-change check can skip an image when too little has changed. Turn auto-generation off for manual control with **Generate Now**; **Force Generate** bypasses scene detection for one request.

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
| **SwarmUI** | Local | Model browsing and component overrides (VAE, text encoders). |
| **SD API** | Local | Connect to a supported stable-diffusion.cpp / A1111 API. |
| **Google Gemini** | Cloud | Prose prompts, multiple aspect ratios, up to 4K. |
| **NovelAI** | Cloud | Anime/illustration with Danbooru-style tags and **director reference images** (character / persona avatars or your own uploads). |
| **NanoGPT** | Cloud | Aggregator — access to Flux, HiDream, DALL·E 3, Imagen 4, Midjourney, Recraft, SDXL, SD 3.5, Reve, and others under one key. |
| **Pollinations** | Cloud | Lightweight provider with optional `enhance`, transparency, and quality tiers. |
| **OpenRouter** | Cloud | Use image-capable models through an OpenRouter connection. |
| **OpenAI** | Cloud | Use an OpenAI image-generation connection (routes to `/images/edits` when a source image is supplied). |
| **Custom (OpenAI-compatible image)** | Cloud / self-hosted | Point at any host with an OpenAI Images-shaped `/images/generations` (Together AI, xAI, Venice compat, Recraft, DeepInfra, LiteLLM, reverse proxies, gateways). Handles both `url` and `b64_json` results. |
| **Together AI** | Cloud | FLUX and other diffusion families via the OpenAI-shaped endpoint. |
| **xAI (Grok Imagine)** | Cloud | Grok Imagine image models; image editing via `/images/edits`. |
| **Venice AI** | Cloud | Native `/image/generate` (negative prompt, aspect ratio + resolution tiers, style presets) plus an OpenAI-compatible connection. |
| **Recraft** | Cloud | Recraft image models; SVG/raster sub-endpoints via the raw override. |
| **DeepInfra** | Cloud | FLUX and other models; `b64_json` responses; LoRA adapters. |
| **Ideogram** | Cloud | Ideogram models; `size` (4.x) or aspect ratio + rendering speed (3.0/2.x); edits ride on the generate endpoint. |
| **Fireworks AI** | Cloud | FLUX and SDXL-class workflow endpoints. |
| **Stability AI** | Cloud | Stable Image Core / Ultra / SD3 (multipart endpoints). |
| **Black Forest Labs** | Cloud | FLUX.2 and FLUX 1.1 Pro; submit-and-poll. |
| **fal.ai** | Cloud | Queue API with a broad model catalog; submit-and-poll. |
| **Replicate** | Cloud | Official and community models; `Prefer: wait` plus polling. |
| **Leonardo.Ai** | Cloud | Leonardo models; submit-and-poll. |
| **Runware** | Cloud | Task-array REST API; can reference Civitai checkpoints directly. |
| **Civitai** | Cloud | Native workflow API (LoRAs, ecosystems, cost preview, free tier) plus a chat-completions image path. |
| **Hugging Face** | Cloud | `hf-inference` text-to-image route. |

See [Setup & Providers](setup.md) for connection setup and per-provider quirks.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Setup & Providers](setup.md) | Create an image-gen connection and configure each provider (including importing a ComfyUI workflow). |
| [Prompts & Presets](prompts-and-presets.md) | Use Scene / Custom / Chat-aware modes, save presets, bind them to a character or persona, and preview the resolved prompt. |
| [Scene, Output & Timeouts](scene-and-output.md) | Configure scene detection, output targets, gallery and context recycling, timeouts, and background display. |
