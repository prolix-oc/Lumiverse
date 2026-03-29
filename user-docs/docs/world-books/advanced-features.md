# Advanced Features

World Books have several advanced features for complex lore management. You don't need these for basic use, but they're powerful when your world grows.

---

## Sticky Entries

When **sticky** is set to a number (e.g., 5), the entry stays active for that many turns *after* its keywords stop appearing. This prevents lore from disappearing the instant the conversation moves on.

**Example:** An entry about a character's magic aura has sticky set to 3. When "aura" is mentioned, the entry activates and stays active for 3 more turns even if "aura" isn't mentioned again.

---

## Cooldown

After an entry deactivates (either naturally or after its sticky period), **cooldown** prevents it from reactivating for a set number of turns.

**Example:** A random encounter entry has cooldown set to 10. After it triggers once, it can't trigger again for 10 turns. This prevents the same encounter from repeating too frequently.

---

## Delay

**Delay** requires a keyword to appear for a set number of consecutive turns before the entry activates. This filters out passing mentions.

**Example:** An entry about growing suspicion has delay set to 3. The keyword "suspicious" must appear in 3 consecutive messages before the entry activates, ensuring it only triggers during a sustained theme rather than a one-off mention.

---

## Groups

Entries can be assigned to a **group**. Within a group, only one entry activates at a time (or entries compete based on weight).

### Group Override

If an entry has **group override** enabled, it "wins" the group competition whenever it activates — other entries in the same group are suppressed.

### Group Weight

When multiple entries in a group activate and none has override, the winner is chosen randomly based on **weight**. Higher weight = higher chance of being selected.

**Example:** A "Weather" group with three entries:
- "Sunny day" (weight: 50)
- "Rainy day" (weight: 30)
- "Thunderstorm" (weight: 20)

When weather-related keywords appear, one of these is randomly selected based on their weights.

---

## Recursion

Activated entries can trigger *other* entries through their content. If Entry A's content contains a keyword from Entry B, Entry B can also activate. This is called **recursion**.

### Recursion Controls

| Setting | Description |
|---------|-------------|
| **Prevent Recursion** | This entry's content won't trigger other entries |
| **Exclude Recursion** | This entry won't contribute to the recursion source text |
| **Delay Until Recursion** | This entry only activates during recursion passes (not the initial scan) |

### Max Recursion Passes

The global **Max Recursion Passes** setting (default: 3) limits how deep recursion goes. This prevents infinite loops where Entry A triggers Entry B which triggers Entry A.

**Example:** An entry for "The Guild" mentions "Aria Blackwood" in its content. If there's an entry for "Aria Blackwood," it activates through recursion — because the Guild entry's content contained Aria's keyword.

---

## Budget Management

When your world book grows large, you need to manage how much context space it consumes.

### Max Activated Entries

Caps the total number of entries that can be active at once. Constant entries count toward the cap but are never evicted — they take priority.

### Max Token Budget

Sets a rough limit on total token consumption by world info content (estimated as characters divided by 4). When the budget would be exceeded, entries are included in priority order until the budget runs out.

### Min Priority

Entries below this priority threshold are excluded entirely (constant entries are exempt).

### Budget Enforcement Order

1. All entries are collected (constants + activated conditional entries)
2. Sorted by priority (highest first)
3. Entry cap applied (lowest-priority conditional entries removed first)
4. Token budget applied (remaining entries included in priority order until budget is full)
5. Constants are never removed

---

## Vectorized Entries

Entries can be **vectorized** — converted to embedding vectors for semantic search rather than keyword matching. When enabled:

- The entry activates based on semantic similarity to the conversation, not exact keyword matches
- This catches related concepts even when the exact keywords aren't used
- Requires an embedding provider to be configured in Settings

Vectorization status is shown per-entry: `not_enabled`, `pending`, `indexed`, or `error`.

---

## World Info State

Per-entry state (sticky counters, cooldown timers, delay counts) is tracked in the chat metadata. This means:

- State is preserved across sessions
- Each chat has independent state
- State resets if you clear chat metadata

You can view activation diagnostics in the **World Book Diagnostics** modal to see which entries are active, cooling down, or delayed.
