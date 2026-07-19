---
title: Scene, Output & Timeouts
---

# Scene, Output & Timeouts

How Lumiverse decides _when_ to generate, _where_ the result goes, and how long it's allowed to take.

---

## Scene Detection (Scene Mode)

When **Prompt Mode** is set to **Scene tool**, every new assistant message triggers a scene parse. The parser returns a structured scene; Lumiverse compares it to the last cached scene for the chat and only generates a new image when enough fields have changed.

| Setting | Default | What it does |
|---------|---------|--------------|
| **Auto-Generate On Reply** | On | When on, every reply triggers a scene parse + (possibly) a generation. When off, Scene mode is manual-only — useful when you want to choose when to refresh the background. |
| **Scene Change Sensitivity** | 2 | Minimum number of scene fields that must change before a new image is generated. Lower = more frequent regenerations. |
| **Ignore Scene Change Detection** | Off | Bypass the cache entirely. Every reply generates a new image. |
| **Include Characters and Persona** | Off | When on, the parser additionally extracts visible characters, appearances, and composition tags. Required to get NovelAI character tags or character-aware Gemini / NanoGPT / Pollinations prompts. |

The compared fields are: `environment`, `time_of_day`, `weather`, `mood`, and `focal_detail`. Character and composition fields don't currently affect the change check — they're extracted for richer prompts but won't trigger a regeneration on their own.

---

## Output Targets

Pick where the result goes under **Prompt Mode → Output**.

| Target | What happens |
|--------|--------------|
| **Set as background** | Replaces the chat background. Honours the configured opacity and fade duration. |
| **Insert into chat** | Posts a new chat message owned by you, with the image as an attachment. Useful when you want the image to live in the chat history. |
| **Attach to last message** | Appends the image to the latest existing message's attachments. Best for adding a visual to the assistant's last reply without inserting a whole new turn. |
| **Preview only** | Generates the image but doesn't place it anywhere. The provider still runs — use this when you're tuning a preset and don't want the chat to fill up. |

### Background display

Two settings control how a background image is shown:

| Setting | Default | What it does |
|---------|---------|--------------|
| **Opacity** | 35% | Background transparency behind the chat. |
| **Fade Duration** | 800ms | Crossfade duration when the background swaps. |

The Image Generation panel also has a **Use as Background** shortcut after generating, plus a **Clear** button to remove the current background.

---

## Gallery & Context Recycling

| Setting | Default | What it does |
|---------|---------|--------------|
| **Add Generated Images to Character Gallery** | On | Links each generated image into the active chat's character gallery as a "Generated image" entry. The link is best-effort — the image is always saved regardless. |
| **Recycle Generated Images Into Context** | Off | When on, recently generated images attached to the chat are re-sent to the LLM as multimodal input on subsequent turns. Only matters if your LLM is multimodal. |
| **Generated Images To Re-Send** | 1 | Maximum number of recent generated images included when recycling is enabled. |

### Removing an image from a message

Right-click (or long-press on touch) an attached image inside a message to bring up the message context menu — it has a **Remove image** action that detaches the image from the message. The image itself stays in your gallery; only the attachment is removed.

---

## Timeouts

Image generation has **two independent timeouts** so a slow parser doesn't block a fast provider (and vice versa).

| Setting | Default | What it covers |
|---------|---------|----------------|
| **Prompt Generation Timeout** | 60 s | Time allowed for the parser LLM phase — Scene parsing or Chat-aware Custom rewriting. Set to `0` to disable. |
| **Image Generation Timeout** | 300 s (5 min) | Time allowed for the image provider itself, measured from the moment the prompt is ready. Set to `0` to disable. |

Both timeouts abort the in-flight generation and surface an error to the panel. Bump the **Image Generation Timeout** when running long ComfyUI workflows or loading large checkpoints on a cold server.

!!! tip "Bypass either timeout by setting it to 0"
    `0` disables the timeout entirely. Use this on local ComfyUI / SwarmUI rigs where you trust the provider to finish eventually, but be aware that a wedged provider won't surface as an error until you cancel manually.

---

## Progress, Previews & Cancellation

ComfyUI and SwarmUI both stream progress events back to the panel:

- A **progress bar** shows the current step and total step count.
- For workflows that emit previews, an in-progress thumbnail appears under the bar so you can see the image forming.
- The panel shows a **Cancel** affordance while a generation is running; starting a new generation for the same chat also aborts the previous one.

Cloud providers (Gemini, NovelAI, NanoGPT, Pollinations) don't expose step-level progress — the panel shows a spinner instead and the result arrives in one shot.

---

## Tips

!!! tip "Scene Change Sensitivity = 1 is noisy"
    A sensitivity of 1 means _any_ change to environment, time-of-day, weather, mood, or focal detail re-triggers a generation. That's usually too much — small wording changes can shift "mood" without the scene actually moving. Start at 2 and only drop to 1 if you want a near-constant refresh.

!!! tip "Attach to last message for assistant snapshots"
    If you want each scene image to belong to the assistant's reply that triggered it, use **Attach to last message** instead of **Insert into chat**. The chat reads more cleanly because there's no extra "image" turn between every reply.

!!! tip "Disable gallery auto-add for short-lived experiments"
    If you're testing a preset by running dozens of generations, turn off **Add Generated Images to Character Gallery** so your gallery doesn't fill with throwaway shots. The images are still saved and accessible from the chat itself.
