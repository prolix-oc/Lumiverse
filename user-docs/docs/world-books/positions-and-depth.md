# Positions & Depth

When a World Book entry activates, it needs to go *somewhere* in the prompt. The **position** setting controls where.

---

## Available Positions

| Position | Code | Where It Goes |
|----------|:----:|---------------|
| **Before Main Prompt** | 0 | Before the character description and main content |
| **After Main Prompt** | 1 | After the main content, before chat history |
| **Before Author's Note** | 2 | Just before the Author's Note injection point |
| **After Author's Note** | 3 | Just after the Author's Note injection point |
| **At Depth** | 4 | Inserted at a specific depth in the chat history |
| **Before Example Messages** | 5 | Before the character's example dialogues |
| **After Example Messages** | 6 | After the character's example dialogues |

---

## Understanding Depth

For entries with the **At Depth** position, the **depth** setting controls how many messages from the end of the chat the entry is inserted.

```
Message 1: "Hello!"                    ← depth 6
Message 2: "Hi there!"                ← depth 5
Message 3: "How are you?"             ← depth 4
[Entry inserted here if depth = 3]    ← depth 3
Message 4: "I'm good."               ← depth 2
Message 5: "What shall we do?"        ← depth 1
Message 6: (AI generates next)        ← depth 0
```

- **Depth 0** — Right at the end, maximum influence on the next response
- **Depth 4** — In the middle of recent conversation, moderate influence
- **Depth 10+** — Far back, subtle influence

### When to Use Depth

- **Depth 0-2** — Critical information that must influence the next response (active quests, immediate danger)
- **Depth 3-5** — Important context that should be "nearby" (character relationships, current scene)
- **Depth 6+** — Background information the AI should be aware of but not fixate on (world rules, distant lore)

---

## Role

Each entry can specify a message **role**:

| Role | Effect |
|------|--------|
| **System** | Treated as system-level context (default, recommended) |
| **User** | Appears as a user message |
| **Assistant** | Appears as an assistant message |

Most entries should use the **System** role. Use user/assistant roles only for specific effects, like injecting fake dialogue patterns.

---

## Order Value

When multiple entries share the same position and depth, the **order value** determines their relative order. Lower values come first.

This is useful when you want certain entries to consistently appear before others at the same insertion point.

---

## Priority

**Priority** is different from position — it controls which entries *survive* when budgets are enforced.

- Higher priority entries are kept when the entry cap or token budget is reached
- Lower priority entries are dropped first
- Constant entries are never dropped regardless of priority

Think of priority as "how important is this entry compared to others?" and position as "where does it go in the prompt?"

---

## Practical Examples

### Location Description (Before Main)
**Position:** Before Main Prompt
> Good for establishing the world setting that frames everything else.

### Active Quest Reminder (At Depth 2)
**Position:** At Depth, Depth: 2
> Keeps the current quest fresh in the AI's mind without being the very last thing it sees.

### World Rules (After Main)
**Position:** After Main Prompt
> General rules about the world that should be established early but after the character's own description.

### Danger Warning (At Depth 0)
**Position:** At Depth, Depth: 0
> "The poison is taking effect. {{char}} has 10 minutes before losing consciousness." — Maximum urgency, right before generation.
