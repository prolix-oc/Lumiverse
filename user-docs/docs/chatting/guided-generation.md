# Guided Generation

Guided generation lets you attach reusable prompt fragments to your messages — short instructions that shape the AI's response without you having to type them every time.

---

## What Are Guides?

A guide is a saved piece of text that gets injected into the prompt at a specific position. You might create guides like:

- "Write in first person, present tense" (system position)
- "Respond with only dialogue, no narration" (system position)
- "Focus on the character's internal thoughts" (before message)

Guides are managed in **Settings > Guided Gen** and toggled on/off from the input area.

---

## Creating a Guide

1. Open **Settings > Guided Gen**
2. Click **New Guide**
3. Fill in:
    - **Name** — A label for quick identification
    - **Content** — The prompt text (supports macros)
    - **Position** — Where it's injected (see below)
    - **Mode** — Persistent or one-shot

---

## Position

| Position | Where It Goes |
|----------|---------------|
| **System** | Injected as a separate system message in the prompt |
| **Before Message** | Prepended to your last user message |
| **After Message** | Appended to your last user message |

Multiple guides can be active at the same time. If several guides share the same position, their content is joined with newlines.

---

## Mode

| Mode | Behavior |
|------|----------|
| **Persistent** | Stays active until you manually turn it off |
| **One-Shot** | Automatically disables itself after one generation |

One-shot is useful for single-turn instructions like "Respond with a haiku" or "Write this scene as a flashback."

---

## Using Guides in Chat

1. Click the **Guides** icon in the input area action bar
2. Toggle any guide on or off
3. Active guides are applied to the next generation

You can have multiple guides active simultaneously — they stack.

---

## Tips

!!! tip "Use guides for recurring instructions"
    Instead of typing "keep it under 2 paragraphs" in every message, create a persistent guide for it. Toggle it off when you want longer responses.

!!! tip "One-shot for experiments"
    Want to try a different writing style for just one response? Create a one-shot guide. It applies once and disappears.
