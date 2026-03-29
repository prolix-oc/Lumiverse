# Creating Entries

Each entry in a World Book is a piece of information that can be injected into the prompt when its conditions are met.

---

## Creating a World Book

1. Open the **World Book** panel
2. Click **New World Book**
3. Give it a name (e.g., "Thornfield Setting," "Magic System," "NPC Roster")
4. Optionally add a description

---

## Adding an Entry

1. Open your world book
2. Click **New Entry**
3. Fill in the key fields:

### Essential Fields

| Field | Description |
|-------|-------------|
| **Keywords** | Words or phrases that trigger this entry (comma-separated) |
| **Content** | The information to inject into the prompt |
| **Comment** | A note for yourself (not sent to the AI) |

### Example Entry

**Keywords:** `Thornfield, castle, the keep`

**Content:**
```
Thornfield Castle is a crumbling medieval fortress perched on a cliff
overlooking the Ashenmere. Its east tower collapsed decades ago and is
now overgrown with ivy. The great hall still stands but the roof leaks.
Lord Maren rules from here with his small household guard of twelve.
The castle's dungeons are rumored to connect to natural caves beneath
the cliff.
```

**Comment:** `Main setting - introduced in Chapter 1`

---

## Writing Good Entry Content

### Be Concise

Each activated entry takes up context space. Write densely — include the important facts without unnecessary prose.

**Too long:**
> Thornfield Castle is a truly magnificent structure, though one that has clearly seen better days. If you were to approach from the western road, you would first notice the imposing silhouette against the sky...

**Better:**
> Thornfield Castle: crumbling medieval fortress on a cliff above the Ashenmere. East tower collapsed (now ivy-covered). Great hall intact but leaky roof. Ruled by Lord Maren with 12 household guards. Dungeons connect to cliff caves.

### Use Structured Formats

The AI processes structured information well:

```
[Aria Blackwood]
Race: Half-elf
Role: Court mage of Thornfield
Personality: Brilliant but absent-minded, speaks in riddles
Secret: Knows the castle dungeons lead to an ancient shrine
Relationship to {{char}}: Rival and reluctant ally
```

### Reference Other Characters

Use macros to keep entries dynamic:

```
{{char}} knows that the Silver Compass always points toward
the nearest ley line. {{user}} has not been told about this artifact yet.
```

---

## Entry States

Each entry can be in one of these states:

| State | Behavior |
|-------|----------|
| **Active (conditional)** | Activates when keywords match |
| **Constant** | Always included, regardless of keywords |
| **Disabled** | Never included |

Use **constant** for critical world rules that should always be present. Use **disabled** to temporarily remove an entry without deleting it.

---

## Tips

!!! tip "One concept per entry"
    Keep entries focused on a single topic (one character, one location, one rule). This makes them activate precisely and keeps token usage efficient.

!!! tip "Use the comment field"
    Comments help you remember what entries are for when you come back to edit them months later. They're free — they don't count toward the prompt.

!!! tip "Test with dry run"
    Use Dry Run to see which entries are activating and where they appear in the prompt. This is the best way to verify your world book is working as intended.
