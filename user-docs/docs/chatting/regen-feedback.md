---
title: Regeneration Feedback
---

# Regeneration Feedback

When you regenerate a response, Lumiverse can prompt you for feedback — a brief note telling the AI *why* you're regenerating. This guides the next attempt in a specific direction instead of just rolling the dice again.

---

## Enabling Regen Feedback

1. Open **Settings > Chat**
2. Toggle **Regen Feedback** on
3. Choose an **injection position**:
    - **User Message** — The formatted feedback prompt is appended to the last user message
    - **System Prompt** — The formatted feedback prompt is appended to the system prompt
4. Optionally customize **Feedback prompt format**. This is a freeform, expandable prompt field. Place `{{$regenInput}}` wherever the submitted feedback should appear; the rest of the field supports normal macros. The default is `[OOC: {{$regenInput}}]`.

---

## How It Works

1. Click the **Regenerate** button on a message
2. A modal appears asking for feedback
3. Type your note (e.g., "Too short — write more detail" or "Stay in character, no modern slang")
4. Click **Submit** — the regeneration runs with your feedback injected
5. Or click **Skip** — the regeneration runs without feedback (same as normal regen)

---

## When to Use It

Regen feedback is most useful when you keep getting the *same kind* of bad response:

- "Less narration, more dialogue"
- "Don't break character"
- "The previous response was too short — aim for 3-4 paragraphs"
- "Focus on the emotional tension, not the action"

Without feedback, the AI may repeat the same mistakes. With feedback, you're giving it a specific correction to work with.
