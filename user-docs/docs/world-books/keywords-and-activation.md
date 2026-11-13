---
title: Keywords & Activation
---

# Keywords & Activation

Understanding how entries activate is the key to making world books work well. This guide covers keyword matching, selective logic, and scan behavior.

---

## Primary Keywords

Every entry has a list of **primary keywords** — words or phrases that trigger the entry. If any primary keyword appears in the recent chat messages, the entry activates.

Keywords are comma-separated:
```
Thornfield, castle, the keep, Lord Maren's home
```

Any one of these appearing in the chat will trigger the entry.

### Matching Options

| Option | Default | Description |
|--------|---------|-------------|
| **Case Sensitive** | Off | Whether "thornfield" and "Thornfield" are treated differently |
| **Match Whole Words** | Off | Whether "castle" matches inside "sandcastle" |
| **Use Regex** | Off | Treat keywords as regular expressions |

!!! tip "Use whole-word matching for common words"
    If your keyword is "fire," whole-word matching prevents it from triggering on "firehouse," "firewall," or "campfire" — unless those are relevant too.

You can force **Case Sensitive** or **Match Whole Words** for every entry at once from **Lorebook → Activation Settings**. Turning a global option off returns control to each entry's own setting without changing any entries.

---

## Secondary Keywords & Selective Logic

Entries can have **secondary keywords** for more precise activation. When **selective** mode is enabled, both primary AND secondary conditions must be met.

### Selective Logic Modes

| Mode | Behavior |
|------|----------|
| **AND** | Primary keyword found AND at least one secondary keyword found |
| **OR** | Primary keyword found AND/OR at least one secondary keyword found |
| **NOT** | Primary keyword found AND no secondary keywords found |
| **NOT All** | Primary keyword found AND not ALL secondary keywords found |

### Example: AND Logic

**Primary keywords:** `Aria`
**Secondary keywords:** `magic, spell, enchantment`
**Logic:** AND

This entry only activates when "Aria" appears AND at least one of "magic," "spell," or "enchantment" also appears. So it triggers for "Aria cast a spell" but not for "Aria walked to the market."

### Example: NOT Logic

**Primary keywords:** `Aria`
**Secondary keywords:** `childhood, young, growing up`
**Logic:** NOT

This entry activates when "Aria" is mentioned but NOT when childhood-related words appear. Useful for separating "adult Aria" lore from "young Aria" lore.

---

## Scan Depth

**Scan depth** controls how many recent messages are checked for keywords.

| Setting | Behavior |
|---------|----------|
| **null (default)** | Scans all messages in the chat |
| **1** | Only checks the most recent message |
| **5** | Checks the last 5 messages |
| **20** | Checks the last 20 messages |

Shorter scan depths make entries activate only when keywords are in the very recent conversation. Longer depths catch keywords mentioned earlier.

!!! tip "Use shorter scan depths for transient information"
    If an entry describes a temporary state (like weather), set scan depth to 3-5 so it fades when the topic changes.

---

## Excluding Text from Scans

Some messages carry text the AI should keep seeing but that should never trigger lore — for example, a story tracker that lists characters who are currently off-scene. Wrap that text in exclusion markup and World Info ignores it, while it stays in the chat and in the prompt.

| Form | Example |
|---|---|
| Tag | `<wi-exclude>Off-scene: Mira, Captain Holt</wi-exclude>` |
| Markers | `!--WI_EXCLUDE_START--!` … `!--WI_EXCLUDE_END--!` |
| Attribute on any HTML element | `<div class="tracker" wi-exclude>…</div>` |

```html
<div class="tracker" wi-exclude>
  Location: The Gilded Anchor
  Off-scene: Mira, Captain Holt
</div>
```

The attribute form excludes the whole element, including everything nested inside it.

- Excluded text is ignored by keyword matching and left out of the vectorized-entry search query. The stored message, the chat display, and what is sent to the AI are unchanged.
- Each message is handled separately. An unclosed block runs to the end of that message only.
- Tag and attribute names are not case-sensitive, and the attribute works with or without a value. Markers must be written exactly as shown.
- Excluded regions are scanned as blank space, so words on either side never join into a new keyword match.
- Lore entry content and recursion are not affected.

!!! tip "Getting the AI to use it"
    Ask in your preset or character instructions for tracker or status blocks to be wrapped in `<div wi-exclude>` or the markers. The markers appear as plain text in chat; a display-target regex script can hide them.

---

## Probability

Set a probability (0-100%) for the entry to activate even when keywords match. At 100%, it always activates. At 50%, it has a coin-flip chance.

Useful for:
- Random encounters
- Flavor text that shouldn't appear every time
- Entries that should feel organic rather than deterministic

Enable probability checking with the **Use Probability** toggle.

---

## Global Scan Settings

These settings (in **Settings > World Info**) apply to all entries:

| Setting | Default | Description |
|---------|---------|-------------|
| **Global Scan Depth** | Unlimited | Number of recent messages searched for both keyword matching and vector retrieval; per-entry overrides affect keyword matching only |
| **Max Recursion Passes** | 3 | How many times keywords in activated entries can trigger other entries |
| **Max Activated Entries** | Unlimited | Cap on total activated entries |
| **Max Token Budget** | Unlimited | Rough token limit for all world info content |
| **Min Priority** | 0 | Entries below this priority are excluded |

---

## How Activation Works (Step by Step)

1. Collect recent messages (up to scan depth)
2. For each enabled, non-constant entry:
    a. Check if any primary keyword appears in the messages
    b. If selective, check secondary keywords with the chosen logic
    c. If probability is enabled, roll the dice
    d. Check delay counter (if configured)
    e. Check cooldown timer (if cooling down)
3. Constant entries are always included
4. Apply group logic (if entries are in groups)

When vectorized world-book entries are enabled, semantic retrieval uses the same **Global Scan Depth** message window. Per-entry scan depth overrides remain specific to that entry's keyword matching and do not suppress independent vector retrieval. Unlimited depth considers all visible, non-empty messages, with the vector query still protected by its token safety limit.
5. Sort by priority
6. Enforce budget limits (entry cap and token budget)
7. Group entries by position (before/after chat history)
