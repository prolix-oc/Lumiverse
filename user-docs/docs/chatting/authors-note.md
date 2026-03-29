# Author's Note

The Author's Note is a hidden instruction you can inject into the conversation at a specific depth. It's like a director's whisper to the AI — the characters don't "see" it, but it shapes how the AI writes.

---

## What Is It?

An Author's Note is a short piece of text inserted into the prompt at a configurable depth in the message history. Unlike system prompts (which go at the top), the Author's Note sits *within* the conversation context, making it highly influential on the AI's next response.

---

## Setting Up an Author's Note

1. In an active chat, click the **Author's Note** button (or find it in the chat controls)
2. Write your instruction
3. Configure:
    - **Depth** — How many messages from the end to insert it (default: 4). Lower numbers = closer to the end = more influence.
    - **Position** — Where relative to the insertion point
    - **Role** — The message role (system, user, or assistant)

### Example Author's Notes

- `[Style: vivid descriptions, focus on sensory details, slow pacing]`
- `[The storm is getting worse. The power could go out at any moment.]`
- `[Write the next response as a flashback to the character's childhood.]`
- `[Increase tension. Something is watching from the shadows.]`

---

## How Depth Works

Depth controls where the Author's Note appears in the message list:

- **Depth 0** — Right at the end, just before the AI generates (strongest influence)
- **Depth 4** — Four messages back from the end (default, balanced)
- **Depth 10** — Ten messages back (subtler influence)

Think of it like recency — the closer to the end, the more the AI "remembers" it when writing.

---

## Per-Chat Setting

The Author's Note is saved per-chat. Each conversation can have its own note with different content, depth, and role. Changes take effect on the next generation.

---

## Tips

!!! tip "Use brackets"
    Wrapping your note in brackets like `[instruction here]` helps the AI recognize it as a meta-instruction rather than dialogue.

!!! tip "Keep it short"
    The Author's Note should be concise — one or two sentences. Long notes eat into your context window and can confuse the AI.

!!! tip "Change it as the story evolves"
    The Author's Note isn't set-and-forget. Update it as the scene changes to keep guiding the narrative in the direction you want.
