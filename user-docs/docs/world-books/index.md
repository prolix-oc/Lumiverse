# World Books

World Books (also called lorebooks) are collections of contextual information that activate during conversations based on keywords. They're how you give the AI detailed knowledge about your world, characters, locations, and lore — without cramming everything into the character description.

---

## How World Books Work

Instead of including all your world's lore in every prompt (which would eat your context window), World Books inject information **only when it's relevant**. When a keyword appears in the recent chat messages, the matching entry's content is added to the prompt.

For example, if you have an entry about "Thornfield Castle" with the keyword "Thornfield," the AI only learns about the castle when someone mentions it in conversation. The rest of the time, that information doesn't take up context space.

---

## Types of World Books

| Type | How It Activates |
|------|-----------------|
| **Character World Book** | Attached to a character — active in all chats with that character |
| **Persona World Book** | Attached to your persona — active whenever that persona is used |
| **Global World Book** | Always active in every chat, regardless of character or persona |

You can have multiple world books active at the same time. Entries from all active books are deduplicated automatically.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Creating Entries](creating-entries.md) | Add lore entries to your world book |
| [Keywords & Activation](keywords-and-activation.md) | How entries match and activate |
| [Positions & Depth](positions-and-depth.md) | Where activated entries appear in the prompt |
| [Advanced Features](advanced-features.md) | Sticky, cooldown, groups, recursion, and budgets |
| [Import & Export](importing-exporting.md) | Share world books between users and platforms |

---

## When to Use World Books

World Books shine when you have:

- **Rich worlds** with many locations, characters, and factions
- **Evolving lore** that changes as the story progresses
- **Shared settings** used across multiple characters
- **Complex backstories** that are relevant only in specific contexts
- **Gameplay systems** with rules that should only appear when invoked

!!! tip "Start simple"
    You don't need a world book to start chatting. Add one when you find the AI doesn't know something important about your world, or when your character description is getting too long.
