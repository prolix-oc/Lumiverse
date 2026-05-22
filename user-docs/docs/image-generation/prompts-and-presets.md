# Prompts & Presets

Lumiverse builds the final image prompt from three things: the **prompt mode** you've chosen, any **preset** you've loaded, and the **character / persona snippets** bound to the active chat. This page covers all three and the **prompt preview** flow you can use to inspect the result before you generate.

---

## Prompt Modes

Set the mode under **Image Generation → Prompt Mode**.

### Scene tool

The default. A sidecar LLM reads the visible chat history and extracts a structured scene:

| Field | Used for |
|-------|----------|
| `environment` | The setting / location |
| `time_of_day` | Lighting cues |
| `weather` | Atmospheric conditions |
| `mood` | Emotional tone |
| `focal_detail` | A specific element to highlight |
| `palette_override` | Optional colour direction |

When **Include Characters and Persona** is enabled, the parser additionally returns visible character names, per-character appearance tags, composition subjects, shot framing, camera angle, and a list of composition rating tags. NovelAI uses these directly as character tags; the other providers fold them into the prose prompt.

Lumiverse caches the previous scene per chat and only generates a new image when at least **Scene Change Sensitivity** fields have changed. Turn on **Ignore Scene Change Detection** to bypass the cache and regenerate on every trigger.

### Custom prompt

Your prompt is sent to the image provider verbatim. Standard macros (`{{user}}`, `{{char}}`, character lookups, etc.) and the character / persona snippet macros described below are still resolved.

### Chat-aware custom

Your text becomes _parser instructions_, not the final prompt. A parser LLM reads the current chat context and rewrites it into an image prompt that follows your guidance.

For example, a parser instruction like:

> Focus on the current pose, expressions, clothing, lighting, and room details. Use concise image-generation tags.

…will produce a different final prompt every reply, tracking what just happened in the chat. This is the best mode when you want both authorial control _and_ scene awareness.

---

## Picking the Parser LLM

Scene and Chat-aware Custom both need a parser LLM. By default Lumiverse uses the **Council sidecar**, but you can override it under **Prompt Parser**:

| Field | Purpose |
|-------|---------|
| **Parser Connection** | Any LLM connection — pick a small / cheap model here to keep parsing fast. |
| **Parser Model** | A specific model on that connection. |
| **Parser Temperature** | Default 0.4. Lower for more deterministic prompts. |
| **Parser Top P** | Default 1. |
| **Parser Max Tokens** | Optional cap. |

The parser is short-lived per request and only runs for Scene and Chat-aware Custom modes. Pure Custom prompts skip it entirely.

---

## Prompt Presets

Custom and Chat-aware prompts can be saved as **presets** and reloaded later. Presets come in three kinds:

| Kind | Purpose |
|------|---------|
| **Main preset** | The full prompt that's actually sent / parsed. There is one active main preset at a time. |
| **Character preset** | A snippet that fills `{{character_prompt}}` (and `{{character_negative_prompt}}`) in whichever main preset is active. |
| **Persona preset** | A snippet that fills `{{persona_prompt}}` (and `{{persona_negative_prompt}}`) in the main preset. |

Use the **Editing** picker in the panel to switch which kind you're editing. Save, rename, and delete buttons sit underneath the editor.

### Bindings

Character and persona presets aren't applied just because they exist — they have to be **bound**:

- **Bind a character preset** by editing it while a chat is open. The preset is bound to that chat's character. From then on, any chat with the same character will splice this snippet into `{{character_prompt}}`.
- **Bind a persona preset** by editing it with that persona active. The preset is bound to your user account against that persona.

A small banner under the editor confirms what the current preset is bound to. Bindings persist across sessions and are stored per user.

### Resolution Order

When generation runs, Lumiverse resolves the prompt in this order:

1. The **main preset** (or the inline panel text if no preset is loaded) is taken as the template.
2. Any `{{character_prompt}}` / `{{character_negative_prompt}}` macro is replaced by the snippet from the character bound to the active chat — if one is bound.
3. Any `{{persona_prompt}}` / `{{persona_negative_prompt}}` macro is replaced by the snippet from the persona bound to your user — if one is bound.
4. Standard macros (`{{user}}`, `{{char}}`, etc.) are evaluated.
5. The result is sent to the image provider (Custom mode) or to the parser LLM (Chat-aware Custom mode).

If a macro is present but no binding exists, the macro expands to an empty string — your prompt still works, just without that snippet.

### Example

**Main preset (Custom mode):**

```text
masterpiece, best quality, {{character_prompt}}, {{persona_prompt}}, indoor lighting, cinematic composition
```

**Negative:**

```text
worst quality, bad anatomy, {{character_negative_prompt}}
```

**Character snippet (bound to "Aria"):**

```text
1girl, long red hair, leather jacket, gold earrings
```

**Persona snippet (bound to your "Detective" persona):**

```text
middle-aged man, glasses, beige coat
```

When you chat as Detective with Aria, the prompt sent to the provider becomes:

```text
masterpiece, best quality, 1girl, long red hair, leather jacket, gold earrings, middle-aged man, glasses, beige coat, indoor lighting, cinematic composition
```

Swap to a different persona or character mid-chat and the splices update automatically on the next generation.

---

## Prompt Preview

Turn on **Preview prompt before generating** (under **Scene Settings**) to inspect the resolved prompt before the image provider is called.

When enabled, hitting **Generate** opens the **Prompt Preview** modal showing the final prompt and negative prompt — fully macro-resolved and (for Scene / Chat-aware modes) already passed through the parser LLM. From there you can:

- **Edit** the prompt and negative prompt directly.
- **Generate** — sends the (possibly edited) prompt straight to the image provider, skipping the parser this time.
- **Cancel** — discard and start over.

This is the easiest way to debug a misbehaving preset or to fine-tune the parser output for one specific scene without changing your saved instructions.

You can also preview without ever generating an image by setting the **Output** target to **Preview only**.

---

## Generating

| Button | Behaviour |
|--------|-----------|
| **Generate** | Generates using the current settings. Respects scene-change detection unless **Ignore Scene Change Detection** is on. |
| **Force Generate** | Bypasses scene-change detection for a single shot. |
| **Auto-Generate On Reply** | When enabled, every new assistant message triggers a Scene-mode generation. Off for manual-only chats. |

Generation runs cooperatively — a new request for the same chat aborts the in-flight one, so you can change your mind without waiting for the previous image to finish.

---

## Tips

!!! tip "Start in Scene mode, graduate to Chat-aware Custom"
    Scene mode is the fastest way to get something on screen. Once you have a feel for what your provider does well, switch to Chat-aware Custom with a short parser instruction — you'll get scenes that match the chat _and_ your style.

!!! tip "Character snippets beat huge main presets"
    A main preset shouldn't describe specific characters — keep it generic and put character details in a bound character snippet. You can then reuse the same main preset across every chat.

!!! tip "Preview is free"
    Previewing the prompt runs the parser LLM but not the image provider. Use it freely to iterate on parser instructions before you spend a generation credit.
