# Context Filters

Context filters strip formatting, tags, and structural content from **older messages** before they're sent to the AI. This keeps the prompt clean and saves context space without affecting how recent messages appear.

---

## How Filters Work

Each filter has a **keep depth** — messages within that many from the end of the chat are left untouched. Messages *older* than the keep depth are filtered.

```
Messages 1-7: Filters applied (older messages)
Messages 8-10: Untouched (within keep depth of 3)
```

This means the AI always sees recent messages in full fidelity, while older messages are progressively cleaned to save tokens.

Configure filters in the **Prompt Panel** under **Context Filters**.

---

## Filter Types

### Strip HTML Tags

Removes formatting tags like `<div>`, `<span>`, `<b>`, `<i>`, `<em>`, `<strong>`, etc. from older messages. The inner text is preserved — only the markup is removed.

| Setting | Description |
|---------|-------------|
| **Enabled** | Turn the filter on/off |
| **Keep Depth** | Last N messages keep their HTML tags (default: 3) |
| **Also Strip Fonts** | Additionally remove `<font>` tags |
| **Font Keep Depth** | Separate keep depth for font tag removal (default: 3) |

**Example:**
Before: `<span style="color:red"><b>Watch out!</b></span>`
After: `Watch out!`

### Filter Details Blocks

Removes `<details>...</details>` elements (collapsible content) from older messages.

| Setting | Description |
|---------|-------------|
| **Enabled** | Turn the filter on/off |
| **Keep Depth** | Last N messages keep their details blocks (default: 3) |
| **Keep Only** | Inverted mode (see below) |

### Filter Loom Tags

Removes Loom system tags (`<loom_sum>`, `<lumia_ooc>`, `<loom_state>`, and 15 other loom-related tags) from older messages.

| Setting | Description |
|---------|-------------|
| **Enabled** | Turn the filter on/off |
| **Keep Depth** | Last N messages keep their Loom tags (default: 5) |
| **Keep Only** | Inverted mode (see below) |

---

## Keep Only Mode

The Details and Loom filters support an inverted **Keep Only** mode. When enabled, older messages are stripped of everything *except* the matching content.

| Normal Mode | Keep Only Mode |
|-------------|----------------|
| Removes `<details>` blocks, keeps everything else | Keeps *only* `<details>` content, removes everything else |
| Removes Loom tags, keeps everything else | Keeps *only* Loom tag content, removes everything else |

**Why is this useful?** It turns structured blocks into a compression mechanism. If your messages contain `<details>` blocks with chapter summaries, Keep Only mode discards the prose from old messages but preserves the summaries — dramatically reducing token usage while retaining key information.

---

## Processing Order

Filters are applied in this order:

1. **Keep Only extraction** (if enabled) — extract only matching content from old messages
2. **Details/Loom stripping** (if not in Keep Only mode) — remove matching content
3. **HTML tag cleanup** — strip formatting tags last

---

## Tips

!!! tip "HTML stripping is the safest starting point"
    Removing formatting tags from old messages is almost always beneficial — the AI doesn't need `<span>` and `<b>` tags from 50 messages ago. Enable this first.

!!! tip "Use Loom tag filtering for long chats"
    Loom tags in old messages can consume significant tokens. A keep depth of 5 means only the 5 most recent messages retain their Loom tags — the rest is cleaned up.

!!! tip "Keep Only mode for structured narratives"
    If you use `<details>` blocks for scene summaries or state tracking, Keep Only mode is extremely powerful — it automatically compresses old messages to just their structured data.
