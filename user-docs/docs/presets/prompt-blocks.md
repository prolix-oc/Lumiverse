# Prompt Blocks

Prompt blocks are the building pieces of your preset. Each block is a section of text that gets assembled into the final prompt sent to the AI.

---

## Block Properties

Every block has these settings:

| Property | Description |
|----------|-------------|
| **Name** | Display label for the block |
| **Content** | The text (can include macros) |
| **Role** | Message role: `system`, `user`, `assistant`, `user_append`, or `assistant_append` |
| **Enabled** | Whether this block is included |
| **Position** | `pre_history`, `post_history`, or `in_history` |
| **Depth** | For `in_history` position — how many messages from the end to insert |
| **Marker** | Structural marker name (for built-in blocks like char_description) |
| **Color** | UI color for visual organization |
| **Locked** | Prevent accidental editing |
| **Injection Trigger** | Which generation types activate this block |
| **Group** | Group membership for block grouping |

---

## Block Types

### Structural Markers

These are "magic" blocks that expand to character/persona/chat data:

| Marker | Expands To |
|--------|------------|
| `char_description` | Character's description field |
| `char_personality` | Character's personality field |
| `scenario` | Character's scenario field |
| `persona` | Your persona's description |
| `mes_examples` | Character's example messages |
| `system_prompt` | Character's system prompt |
| `post_history_instructions` | Character's post-history instructions |
| `chat_history` | All chat messages |
| `world_info_before` | World book entries (before position) |
| `world_info_after` | World book entries (after position) |

### Content Blocks

Custom blocks you write yourself. These can contain any text and macros:

```
Write vivid, sensory descriptions. Show, don't tell.
Keep responses between 2-4 paragraphs.
Always stay in character as {{char}}.
```

### Category Markers

Visual dividers in the block list — they don't produce output, just help organize your blocks in the editor.

---

## Block Ordering

The order of blocks in the list determines their order in the assembled prompt. Drag blocks to rearrange them.

A typical order looks like:

1. System prompt
2. Character description
3. Personality
4. Scenario
5. Persona description
6. World info (before)
7. Example messages
8. Chat history
9. World info (after)
10. Post-history instructions
11. Author's note (injected at depth)

But this is just a starting point — experiment to find what works best for your use case and model.

---

## Roles

The **role** determines how the AI interprets the block:

| Role | AI Interpretation |
|------|-------------------|
| `system` | Background instructions (highest authority) |
| `user` | Appears as a user message |
| `assistant` | Appears as the AI's own prior output |
| `user_append` | Appended to the previous user message |
| `assistant_append` | Appended to the previous assistant message |

Most instruction blocks should use `system` role. Use `user` or `assistant` roles sparingly for specific effects (like fake dialogue examples).

---

## Injection Triggers

By default, a block is included in every generation. You can limit it to specific generation types:

| Trigger | When Active |
|---------|-------------|
| `normal` | Regular message sending |
| `continue` | When continuing a response |
| `regenerate` | When regenerating a response |
| `swipe` | When generating a swipe |
| `impersonate` | When the AI writes as the user |
| `quiet` | Background/silent generations |

Leave the trigger list empty to include the block in all generation types.

---

## Prompt Variables

Blocks can define **Prompt Variables**—typed inputs that allow users to customize the preset's behavior without editing the raw block text.

For example, you might create a `tone` variable (text) or a `verbosity` variable (slider). When a user selects your preset, they are presented with a clean UI to fill out these variables, and the values are automatically injected into your macros.

Read the [Prompt Variables guide](prompt-variables.md) for full instructions on how to define them as a creator, and how users interact with them via the Prompt Variables Modal.

---

## Block Groups

Blocks can be assigned to **groups** for collective behavior. Groups support two modes:

- **Radio** — Only one block in the group is active at a time (selecting one deselects the others)
- **Checkbox** — Multiple blocks can be active simultaneously

Groups are useful for creating alternative instruction sets (e.g., different writing styles) where you want to pick one at a time.

---

## Tips

!!! tip "Start simple"
    Begin with just a system prompt block and the structural markers. Add custom blocks as you learn what influences the AI's behavior.

!!! tip "Use the dry run"
    After configuring blocks, use **Dry Run** to see the assembled prompt. This shows you exactly what the AI receives, including resolved macros and injected world info.

!!! tip "Disable, don't delete"
    If a block isn't working well, disable it instead of deleting it. You can re-enable it later or reference it when building other blocks.
