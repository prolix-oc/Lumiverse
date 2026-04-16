# Regex Scripts

Regex scripts are text transformation rules that automatically find and replace patterns in your messages. They can clean up formatting, enforce style rules, or transform content at various stages of the pipeline.

---

## What Can Regex Scripts Do?

- Remove unwanted formatting (asterisks, brackets, etc.)
- Convert text styles (e.g., *italic markers* to actual HTML italics)
- Enforce naming conventions
- Strip or transform specific patterns
- Add HTML formatting to AI output
- Clean up reasoning tags or other artifacts

---

## Creating a Script

1. Open the **Regex Scripts** panel
2. Click **New Script**
3. Fill in:

| Field | Description |
|-------|-------------|
| **Name** | A label for your reference |
| **Find Regex** | The pattern to search for (regular expression) |
| **Replace String** | What to replace matches with |
| **Flags** | Regex flags: `g` (global), `i` (case-insensitive), `m` (multiline), `s` (dotAll) |

### Example: Remove Asterisks

**Find:** `\*([^*]+)\*`
**Replace:** `<em>$1</em>`
**Flags:** `g`

This converts `*italic text*` into `<em>italic text</em>`.

---

## Placement

**Placement** controls which parts of the text the script runs on:

| Placement | What It Affects |
|-----------|----------------|
| **User Input** | Your messages before they're sent |
| **AI Output** | The AI's response |
| **World Info** | World book entry content |
| **Reasoning** | Reasoning/thinking blocks |

You can select multiple placements for the same script.

---

## Target

**Target** controls *when* in the pipeline the script runs:

| Target | When It Runs |
|--------|-------------|
| **Prompt** | Applied to the assembled prompt before sending to the AI |
| **Response** | Applied to the AI's output before saving to the database |
| **Display** | Applied at render time in the UI (doesn't change stored data) |

- Use **prompt** target to modify what the AI sees
- Use **response** target to clean up AI output before it's saved
- Use **display** target for visual-only transformations (the underlying text stays unchanged)

---

## Scope

| Scope | Applies To |
|-------|-----------|
| **Global** | All chats |
| **Character** | Only chats with a specific character |
| **Chat** | Only a specific chat |

**Resolution order:** Global scripts run first, then character-scoped, then chat-scoped. Within each tier, scripts run in sort order.

---

## Advanced Options

| Option | Description |
|--------|-------------|
| **Min/Max Depth** | Only apply to messages within a depth range |
| **Trim Strings** | Additional strings to strip from matches |
| **Run on Edit** | Re-run when you edit a message |
| **Substitute Macros** | Replace macros in the replacement string (`none`, `raw`, `escaped`) |
| **Folder** | Organizational grouping |

---

## Testing Scripts

Before saving, use the **Test** feature:

1. Click **Test** on your script
2. Enter sample text
3. See the result, including matched portions and the transformed output

This lets you verify your regex works correctly before it affects real conversations.

---

## Import & Export

Scripts can be imported and exported as JSON. Lumiverse also supports importing SillyTavern-format regex scripts for easy migration.

---

## Tips

!!! tip "Start with display target"
    If you're not sure about a regex, use the **display** target first. It only affects how text looks in the UI — it can't break your stored data. Once you're confident, switch to response or prompt target.

!!! tip "Use the `g` flag"
    Most scripts should use the `g` (global) flag to replace all occurrences, not just the first one.

!!! tip "Test with edge cases"
    Regex can have unexpected matches. Test with text that looks similar but shouldn't match to make sure your pattern is precise enough.
