# Understanding Presets

This guide explains how presets work conceptually, so you can create and customize them with confidence.

---

## The Prompt Assembly Pipeline

When you send a message, Lumiverse doesn't just forward your chat history to the AI. It assembles a structured **prompt** from multiple sources:

```
┌─────────────────────────────┐
│  Preset Blocks (in order)   │
│  ├── System Prompt          │
│  ├── Character Description  │
│  ├── Personality            │
│  ├── Scenario               │
│  ├── Persona                │
│  ├── World Info (before)    │
│  ├── Chat History           │
│  ├── World Info (after)     │
│  ├── Author's Note          │
│  └── Custom Blocks...       │
├─────────────────────────────┤
│  Sampler Parameters         │
│  (temperature, top_p, etc.) │
└─────────────────────────────┘
```

Each block in the preset can be enabled/disabled, reordered, and customized. This gives you granular control over every part of the prompt.

---

## Preset Components

### Prompt Order (Blocks)

The `prompt_order` is a list of blocks that defines what goes into the prompt and in what order. Each block has:

- **Name** — What this block is called
- **Content** — The text or macro that gets inserted
- **Role** — Whether it's a `system`, `user`, or `assistant` message
- **Enabled** — Whether this block is active
- **Position** — Where it appears relative to the chat history

### Prompts (Named Text Blocks)

The `prompts` map stores named text content used by the preset — things like the main system prompt, continuation nudges, and impersonation instructions.

### Parameters

Sampler settings that control *how* the AI generates (creativity, randomness, length).

### Metadata

Additional configuration like completion settings, sampler overrides, and behavioral flags.

---

## How Blocks Become a Prompt

During assembly, Lumiverse walks through the block list in order:

1. **Marker blocks** (like `char_description`, `scenario`, `persona`) are replaced with the corresponding character/persona data
2. **Content blocks** have their text run through the macro resolver (replacing `{{char}}`, `{{user}}`, etc.)
3. **World Info blocks** are filled with activated lorebook entries
4. **Chat history** inserts all the conversation messages
5. **Special blocks** (Author's Note, continuation nudges) are injected at configured depths

The result is a complete, ordered list of messages sent to the AI.

---

## Macros in Presets

Blocks can contain **macros** — template variables that get replaced with dynamic content. For example:

```
You are {{char}}, a {{personality}} character in the following scenario:
{{scenario}}

The user's name is {{user}}.
{{persona}}
```

This becomes:

```
You are Aria, a curious and adventurous character in the following scenario:
A bustling market square in a medieval fantasy city...

The user's name is Alex.
Alex is a 28-year-old freelance photographer...
```

See the [Macros guide](../customization/macros.md) for a complete reference.

---

## Fallback Behavior

If no preset is linked to your connection, or the preset has no blocks, Lumiverse falls back to a simple mode: it maps your chat messages directly to `{role, content}` pairs and sends them as-is. This works, but you lose all the advanced features (world info, macros, author's note, etc.).

---

## Linking Presets to Connections

Each connection can optionally link to a preset. When you generate using that connection, its linked preset is used for assembly. You can also switch presets independently of connections.
