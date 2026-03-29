# Sovereign Hand

Sovereign Hand is a co-pilot mode that reframes how the AI interprets your messages. Instead of treating what you write as your character's dialogue, the AI treats it as **directorial instructions** — stage directions from the author telling the story what should happen next.

---

## What It Does

In normal mode, when you type "I walk to the door," the AI reads that as your character performing an action and responds accordingly.

With Sovereign Hand enabled, when you type "The character notices the tension in the room and decides to confront it," the AI interprets this as a narrative directive. It elaborates on your instruction, writing the scene as if the impulse came naturally from the story world — not parroting your words back, but expanding on them with the character's voice, internal thoughts, and actions.

**You become the director. The AI becomes the performer.**

---

## Setting Up

Open the **Prompt Panel** and find the **Sovereign Hand** section:

| Setting | Description |
|---------|-------------|
| **Enable Sovereign Hand** | Master toggle |
| **Exclude Last Message** | Removes your message from the chat context sent to the AI |
| **Include Message in Master Prompt** | Places your message inside the Sovereign Hand system instruction instead |

---

## How the Settings Interact

### Both toggles on (recommended)

Your message is removed from the chat history and placed *only* in the Sovereign Hand system section. The AI sees your directive as an authorial instruction, not as dialogue. This produces the cleanest results — the AI doesn't accidentally quote or reference your message as if it were spoken in-world.

### Include on, Exclude off

Your message appears in **both** the chat history and the Sovereign Hand section. The AI is told not to duplicate it. Useful if you want the message to serve double duty as both an in-character action and a directive.

### Both toggles off

Sovereign Hand is technically enabled but doesn't modify message routing. The `{{loomSovHand}}` macro still produces the co-pilot prompt, but your message flows through normally. Useful if your preset handles the routing differently.

---

## Continuation Mode

When the **character** spoke last (not you), Sovereign Hand enters **Continuation Mode** automatically. Instead of processing a user directive, the AI is instructed to continue the narrative naturally from where the character left off.

The `{{loomContinuePrompt}}` macro produces continuation instructions in this scenario, guiding the AI to extend the story without repeating the character's last message.

---

## Core Principles

The Sovereign Hand prompt instructs the AI to follow these rules:

1. **Interpret, don't transcribe.** The user's words are stage directions, not dialogue.
2. **The user is the author.** Their message describes what should happen.
3. **Maintain narrative continuity.** Everything should feel like a natural story extension.
4. **The character acts on the directive** as if the impulse came from the story world.

---

## Writing Good Directives

With Sovereign Hand active, your messages should read like stage directions or narrative instructions:

**Instead of:**
> "I'm scared. I don't want to go in there."

**Write:**
> "The character hesitates at the threshold, fear gnawing at them. They notice the scratches on the doorframe."

**Or even shorter:**
> "Reluctance. Fear. Focus on the doorframe scratches."

The AI expands your shorthand into fully realized prose, using the character's established voice and personality.

You can also give meta-level instructions:

> "Slow the pacing down. Describe the environment in detail before any dialogue."

> "Have two characters disagree about the plan. Build tension but don't resolve it yet."

---

## Related Macros

| Macro | Purpose |
|-------|---------|
| `{{loomSovHand}}` | The full Sovereign Hand co-pilot prompt — include this in your preset |
| `{{loomSovHandActive}}` | `"yes"` / `"no"` — for conditional blocks |
| `{{loomContinuePrompt}}` | Continuation instructions (active when character spoke last) |
| `{{loomLastUserMessage}}` | Your last message text |
| `{{loomLastCharMessage}}` | The character's last message text |

Include `{{loomSovHand}}` in a preset block for the feature to work. Wrap it in a conditional if you want the block to disappear when Sovereign Hand is off:

```
{{if::{{loomSovHandActive}}}}
{{loomSovHand}}
{{/if}}
```

---

## Tips

!!! tip "Think like a director"
    The more you write like a screenplay director ("Focus on the silence between them. Let the tension build.") rather than an actor ("I look at her nervously."), the better Sovereign Hand performs.

!!! tip "Use with Loom Summary"
    Sovereign Hand pairs well with [Loom Summary](../chatting/loom-summary.md). The summary gives the AI story context, and your directives tell it where to take the story next.

!!! tip "Try brief directives"
    You don't need to write paragraphs. "Flashback to childhood. Bittersweet." is enough for the AI to construct a full scene. The character card and conversation history provide the rest.
