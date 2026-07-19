---
title: Regex Scripts
---

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
| **Memory** | Content as it's written to long-term memory |

You can select multiple placements for the same script.

**Memory** placement is independent of target: it strips text as it's saved to long-term memory (vector search and the memory cortex), before storage and embedding, while the displayed message keeps the full text. Use it to keep tracker or HUD blocks out of recalled memory. Macros aren't available at ingestion, so memory scripts must use literal patterns.

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

## Associative Regex Actions

Associative regex actions turn elements in replacement HTML into choices. This is useful for interactive scene cards, CYOA responses, suggested dialogue, loadout selectors, and similar interfaces.

Actions require a script with the **Display** target. In the replacement HTML, associate a clickable element with an action by giving it a `data-regex-action` value:

```html
<button type="button" data-regex-action="enter-gate">Enter the gate</button>
```

Then add an action in the script's **Actions** section whose ID is `enter-gate`. An element's regular `id` attribute can also be used, but `data-regex-action` is recommended because it does not interfere with CSS or page IDs.

Each action has these fields:

| Field | Description |
|-------|-------------|
| **ID** | Connects the action to `data-regex-action` in the replacement HTML. IDs must be unique within the script. |
| **Type: Send** | Sends visible user content and starts generation immediately. |
| **Type: Append** | Waits for the user's next message, then adds hidden content to that generation's prompt. |
| **Type: Effects only** | Claims the choice without sending a message. Use this for state, editable drafts, forks, or combinations of them. |
| **Multi-select option** | Lets this option be selected independently. Multi-select actions are staged instead of generating immediately, then stacked on the next Send. |
| **Selection cost** | Numeric cost of a multi-select option. Accepts a literal such as `2` or a capture such as `$3`, allowing the regex creator or generated output to set the price. |
| **Block cost limit** | Positive total-cost bound for the rendered block. Accepts literals and captures. If options resolve different limits, the lowest positive value is enforced. |
| **Title / Subtitle** | Labels and hover text for the action. These may contain capture references. |
| **Content** | The visible message or hidden prompt modifier produced by the action. |
| **State effects** | Optional chat-variable updates committed when the action is claimed. The key is fixed by the creator; the value may contain capture references. |

Titles, subtitles, content, cost, and limit support the same capture references as the replacement string, including `$1`, `$2`, `$&`, and named captures such as `$<location>`.

### Persistent state effects

Use **Add state effect** to let a choice update a persistent chat variable. State values are available to prompts and later regex scripts through `{{getchatvar::key}}`.

For example, an action matching a named `route` capture can set:

```json
{
  "type": "set_state",
  "key": "adventure.route",
  "value": "$<route>"
}
```

The key is creator-defined and cannot contain captures. Values and drafts are resolved from the stored assistant message when the action is claimed. Actions containing composable effects are disabled in user messages and rejected by the server; editing the browser payload cannot choose a different key, value, draft, or fork point.

Effects are additive and backward compatible. Existing actions without an `effects` field continue to behave exactly as before. A state effect is committed with the action's normal one-shot claim, including batched multi-select claims.

### Draft and fork effects

A **draft** effect places capture-resolved text in the composer without sending it. It can either replace the current draft or append to it, leaving the user free to edit before sending.

A **fork** effect creates and opens a chat branch at the assistant message that rendered the action. Combine it with state and draft effects to build a complete branching choice:

```json
{
  "id": "take-rooftops",
  "type": "effects",
  "multi_select": false,
  "cost": "1",
  "limit": "3",
  "title": "Take the rooftops",
  "subtitle": "Create an editable branch",
  "content": "",
  "effects": [
    { "type": "set_state", "key": "adventure.route", "value": "$<route>" },
    { "type": "fork" },
    { "type": "draft", "mode": "replace", "content": "Let's take $<route>." }
  ]
}
```

The state update and fork are committed together. The new branch inherits the updated chat state, then opens with the draft waiting in its composer. Draft and fork effects require an **Effects only** action and cannot be multi-select. State effects may also be attached to existing Send or Append actions.

### One-shot behavior

Each rendered regex match is a stateful action block. A normal action consumes the entire block when selected. Multi-select choices remain provisional until Send: click an option once to add it and click it again to remove it. At Send, the selected options are claimed together and become one-shot.

Used choices stay disabled when the user scrolls away, refreshes, or opens the chat on another client. This prevents an old scene card from triggering the same generation influence more than once. If normal and multi-select actions are mixed in one block, a normal **Send** action acts as the commit trigger: its content and all staged modifiers are claimed and sent together. A normal **Append** action is non-triggering and cannot replace staged selections from its own block.

### How multi-select content is applied

Multi-select actions wait for the next Send signal:

- An option can be toggled on or off until Send begins.
- A new option is rejected when its cost would put the block above its limit.
- Clicking a normal Send action also counts as Send and batches that action with every staged modifier.
- **Send** modifiers are joined to the user's visible message, separated by blank lines.
- **Append** modifiers are stacked in a hidden prompt appendix attached to that user message.
- A visible Send modifier can enable Send even when the text box is empty.
- Append-only selections keep waiting until the user sends an actual message.

### Importable examples

- [Scene card with a single action](../assets/examples/regex-actions/scene-card-action.json) transforms `<scene>...</scene>` output into a styled HTML card. Its button sends the captured choice immediately.
- [Multi-select scene planner](../assets/examples/regex-actions/multi-select-scene-planner.json) provides two visible selections and one hidden tone modifier, all stacked on the next Send.

The first example expects AI output shaped like this:

```xml
<scene>
  <location>Moonlit Courtyard</location>
  <description>A silver gate stands between ivy-covered walls.</description>
  <choice>Open the silver gate</choice>
</scene>
```

The multi-select demo expects:

```xml
<scene-options>
  <title>Crossing the Sleeping City</title>
  <budget>3</budget>
  <route cost="2">Take the rooftops</route>
  <companion cost="1">Bring Lyra</companion>
  <tone cost="1">Keep the scene tense and quiet</tone>
</scene-options>
```

Import either JSON file through **Regex Scripts → Import**.

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
| **Substitute Macros** | Replace macros in the **find** and **replace** strings. Modes: `none` (no substitution), `raw` (substitute before matching, capture groups see the raw output), `escaped` (substitute and regex-escape the result so special characters in macro output don't break the pattern), `after` (substitute *after* the match runs — useful when you want capture groups to feed into a macro in the replacement string) |
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
