# Macros Reference

Macros are template variables written as `{{macro_name}}` that get replaced with dynamic content when your preset is assembled into a prompt. This is the complete reference of every built-in macro in Lumiverse.

---

## How to Use Macros

Place macros anywhere in your preset blocks, world book entries, or other text fields:

```
You are {{char}}, a character described as: {{description}}
You are speaking with {{user}}.
{{persona}}
```

During prompt assembly, each macro is replaced with its current value.

### Arguments

Some macros accept arguments, separated by `::` (double colon):

```
{{random::1::100}}          — random number between 1 and 100
{{pick::cat::dog::bird}}    — randomly selects one item
{{roll::2d6}}               — rolls two six-sided dice
```

!!! warning "Always use `::` to pass arguments"
    Arguments are separated by `::` (double colon). A space after the macro name does **not** separate arguments — `{{random 1 100}}` passes `"1 100"` as a single string, not two numbers. Always use `{{random::1::100}}`.

### Scoped Macros

A few macros wrap content between opening and closing tags:

```
{{if::{{isGroupChat}}}}
This is a group conversation with {{group}}.
{{else}}
This is a private conversation.
{{/if}}
```

### Flags

Macros support prefix flags for advanced control:

| Flag | Syntax | Effect |
|------|--------|--------|
| Immediate | `{{~immediate macro}}` | Resolve before other macros |
| Delayed | `{{~delayed macro}}` | Resolve after recursion passes |
| Preserve | `{{~preserve macro}}` | Keep surrounding whitespace |

---

## Core Macros

Utility macros for text manipulation and flow control.

| Macro | Aliases | Description |
|-------|---------|-------------|
| `{{space}}` | — | Inserts a literal space character |
| `{{newline}}` | `{{nl}}`, `{{n}}` | Inserts a literal newline |
| `{{noop}}` | — | No operation — resolves to nothing |
| `{{trim}}...{{/trim}}` | — | Trims whitespace from the enclosed content |
| `{{comment::...}}` | `{{note::...}}` | Comment — content is discarded, produces no output |
| `{{//::...}}` | — | Inline comment shorthand |
| `{{input}}` | — | The raw text of the last user message |
| `{{reverse::text}}` | — | Reverses the given text |
| `{{outlet}}` | — | Placeholder for extension injection points |
| `{{banned}}` | — | Placeholder for banned token lists |

### Conditional Logic

```
{{if::condition}}
  Content when true
{{else}}
  Content when false
{{/if}}
```

The condition can be any macro that returns `"yes"` or `"true"`. Several macros are specifically designed to work as conditions — they're marked below.

---

## Identity & Names

Macros for character and user identity.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{user}}` | — | Your persona name (or username if no persona) |
| `{{char}}` | `{{charName}}` | The current character's name |
| `{{group}}` | — | Comma-separated list of all group member names |
| `{{groupNotMuted}}` | `{{group_not_muted}}` | Names of non-muted group members |
| `{{notChar}}` | `{{not_char}}` | The non-character party (usually the user) |
| `{{charGroupFocused}}` | `{{charFocused}}`, `{{char_group_focused}}` | The targeted character in a group chat |
| `{{isGroupChat}}` | `{{is_group_chat}}` | `"yes"` or `"no"` — usable as a condition |
| `{{groupOthers}}` | `{{group_others}}` | Group members excluding the focused character |
| `{{groupMemberCount}}` | `{{group_member_count}}` | Number of characters in the group |
| `{{groupLastSpeaker}}` | `{{group_last_speaker}}` | Last character who spoke |

---

## Character Data

Macros that pull from the character card fields. These respect [alternate field](../characters/alternate-fields.md) selections.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{description}}` | `{{charDescription}}` | Character's description |
| `{{personality}}` | `{{charPersonality}}` | Character's personality |
| `{{scenario}}` | `{{charScenario}}` | Character's scenario |
| `{{persona}}` | `{{userPersona}}` | Your persona's description (includes enabled add-ons) |
| `{{mesExamples}}` | `{{mes_examples}}`, `{{exampleMessages}}` | Character's example dialogue |
| `{{mesExamplesRaw}}` | — | Raw example dialogue (unprocessed) |
| `{{system}}` | `{{charPrompt}}`, `{{charSystem}}` | Character's system prompt |
| `{{charPostHistoryInstructions}}` | `{{charInstruction}}`, `{{jailbreak}}`, `{{charJailbreak}}` | Post-history instructions |
| `{{charDepthPrompt}}` | `{{depth_prompt}}` | Character's depth prompt (from extensions) |
| `{{charCreatorNotes}}` | `{{creatorNotes}}` | Creator's notes (informational) |
| `{{charVersion}}` | — | Character card version |
| `{{charCreator}}` | — | Character creator's name |
| `{{firstMessage}}` | `{{firstMes}}`, `{{first_message}}` | Character's first/greeting message |
| `{{original}}` | — | Character description (original card text) |

---

## Chat & Conversation

Macros for the current chat state.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{lastMessage}}` | `{{last_message}}` | Content of the most recent message |
| `{{lastMessageId}}` | `{{last_message_id}}` | Index of the last message |
| `{{lastUserMessage}}` | `{{last_user_message}}` | Content of the last message from you |
| `{{lastCharMessage}}` | `{{last_char_message}}`, `{{lastBotMessage}}` | Content of the last character message |
| `{{lastMessageName}}` | — | Name of whoever sent the last message |
| `{{messageCount}}` | `{{message_count}}`, `{{messagecount}}` | Total message count in the chat |
| `{{chatId}}` | `{{chat_id}}` | The current chat's unique ID |
| `{{firstIncludedMessageId}}` | — | Index of the first message included in the prompt |
| `{{firstDisplayedMessageId}}` | — | Index of the first displayed message |
| `{{lastSwipeId}}` | — | Index of the last swipe on the final message |
| `{{currentSwipeId}}` | — | Index of the active swipe |

---

## Time & Date

Macros for current time information.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{time}}` | — | Current time (`HH:MM`) | Optional: UTC offset (e.g., `{{time::UTC+2}}`) |
| `{{date}}` | — | Current date (`Month Day, Year`) | — |
| `{{weekday}}` | — | Day of the week | — |
| `{{isotime}}` | — | ISO 8601 date and time | — |
| `{{isodate}}` | — | ISO date (`YYYY-MM-DD`) | — |
| `{{datetimeformat::...}}` | — | Custom formatted date/time | Intl.DateTimeFormat options as `key=value` |
| `{{idleDuration}}` | `{{idle_duration}}` | Human-readable time since last message | — |
| `{{timeDiff::date1::date2}}` | `{{time_diff}}` | Human-readable difference between two dates | Two ISO date strings (second defaults to now) |

**Examples:**

```
It is currently {{time}} on {{weekday}}, {{date}}.
The user has been idle for {{idleDuration}}.
```

---

## Random & Entropy

Macros for randomness and dice rolling.

| Macro | Returns | Args |
|-------|---------|------|
| `{{random::min::max}}` | Random integer between min and max | Two numbers separated by `::`, or a list of items |
| `{{pick::item1::item2::...}}` | One randomly chosen item | List of options separated by `::` |
| `{{roll::NdS}}` | Dice roll total | Dice notation (e.g., `2d6`, `1d20`, `3d8`) |

**Examples:**

```
{{char}} rolls a {{roll::1d20}} on their perception check.
The weather today is {{pick::sunny::cloudy::rainy::stormy}}.
A random number: {{random::1::100}}
```

---

## Variables

Read and write persistent values — **local** (per-chat) or **global** (cross-chat).

### Local Variables (Chat-Scoped)

| Macro | Description | Args |
|-------|-------------|------|
| `{{getvar::key}}` | Get a variable's value | Variable name |
| `{{setvar::key::value}}` | Set a variable (returns nothing) | Name and value |
| `{{addvar::key::value}}` | Add a number to a variable | Name and number |
| `{{incvar::key}}` | Increment by 1 | Variable name |
| `{{decvar::key}}` | Decrement by 1 | Variable name |
| `{{hasvar::key}}` | Check if variable exists (`"true"` / `"false"`) | Variable name |
| `{{deletevar::key}}` | Delete a variable | Variable name |

Aliases: `{{varexists}}` for `{{hasvar}}`, `{{flushvar}}` for `{{deletevar}}`

### Global Variables (Cross-Chat)

| Macro | Description | Args |
|-------|-------------|------|
| `{{getgvar::key}}` | Get a global variable | Variable name |
| `{{setgvar::key::value}}` | Set a global variable | Name and value |
| `{{addgvar::key::value}}` | Add a number to a global variable | Name and number |
| `{{incgvar::key}}` | Increment by 1 | Variable name |
| `{{decgvar::key}}` | Decrement by 1 | Variable name |
| `{{hasgvar::key}}` | Check if exists (`"true"` / `"false"`) | Variable name |
| `{{deletegvar::key}}` | Delete a global variable | Variable name |

Aliases: `{{getglobalvar}}`, `{{setglobalvar}}`, `{{addglobalvar}}`, `{{incglobalvar}}`, `{{decglobalvar}}`, `{{hasglobalvar}}`, `{{gvarexists}}`, `{{flushgvar}}`, `{{flushglobalvar}}`, `{{deleteglobalvar}}`

**Example — Tracking a quest:**

```
{{setvar::quest_stage::2}}
Current quest stage: {{getvar::quest_stage}}

{{if::{{hasvar::secret_discovered}}}}
You know the secret about the crystal.
{{/if}}
```

`setvar` also supports scoped syntax — the enclosed content becomes the value:

```
{{setvar::diary_entry}}The events of today were extraordinary...{{/setvar}}
```

---

## Runtime & State

Information about the current system state.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{model}}` | — | Current LLM model name |
| `{{isMobile}}` | `{{is_mobile}}` | Whether the client is mobile |
| `{{maxPrompt}}` | `{{maxPromptTokens}}`, `{{max_prompt}}` | Maximum prompt token count |
| `{{maxContext}}` | `{{maxContextTokens}}`, `{{max_context}}` | Maximum context window tokens |
| `{{maxResponse}}` | `{{maxResponseTokens}}`, `{{max_response}}` | Maximum response tokens |
| `{{lastGenerationType}}` | `{{last_generation_type}}` | Last generation type (`normal`, `continue`, `regenerate`, etc.) |
| `{{hasExtension::name}}` | `{{has_extension}}` | `"true"` / `"false"` — whether a named extension is active |
| `{{userColorMode}}` | `{{user_color_mode}}`, `{{colorMode}}`, `{{color_mode}}` | User's color scheme (`dark`, `light`, or `system`) |

---

## Reasoning / Chain-of-Thought

For models that support extended thinking (DeepSeek, Claude, o1).

| Macro | Description | Args |
|-------|-------------|------|
| `{{reasoningPrefix}}` | Opening tag for reasoning blocks | Optional: `{{reasoningPrefix::raw}}` to strip surrounding newlines |
| `{{reasoningSuffix}}` | Closing tag for reasoning blocks | Optional: `{{reasoningSuffix::raw}}` to strip surrounding newlines |

**Example:**

```
{{reasoningPrefix}}
Think step by step about what {{char}} would do next.
{{reasoningSuffix}}
```

---

## Memory

Long-term memory retrieval from the vector memory system.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{memories}}` | `{{longTermMemory}}`, `{{chatMemory}}`, `{{ltm}}` | Formatted memory chunks with header | Optional: `{{memories::count}}` to override chunk count |
| `{{memoriesActive}}` | — | `"yes"` / `"no"` — whether memories were retrieved (condition-compatible) | — |
| `{{memoriesCount}}` | — | Number of memory chunks retrieved | — |
| `{{memoriesRaw}}` | — | Raw memory chunks without header formatting | Optional: `{{memoriesRaw::count}}` to override chunk count |

---

## Pipeline

Results from Lumi Engine pipeline modules.

| Macro | Returns | Args |
|-------|---------|------|
| `{{pipeline}}` | All enabled pipeline module results, formatted as labeled sections | — |
| `{{pipe::module_key}}` | A specific pipeline module's result | Module key name |

---

## Lumia & Council

Macros for the council deliberation system and Lumia personas. These resolve to content only when the relevant systems are enabled.

### Lumia Identity

| Macro | Description | Args |
|-------|-------------|------|
| `{{randomLumia}}` | A random Lumia from all packs (cached per generation) | Optional: `{{randomLumia::name}}`, `::phys`, `::pers`, or `::behav` |
| `{{lumiaDef}}` | Selected Lumia definition — adapts for Council (multi-member) and Chimera (fusion) modes | Optional: `{{lumiaDef::len}}` to get count |
| `{{lumiaBehavior}}` | All selected behavioral traits | Optional: `{{lumiaBehavior::len}}` to get count |
| `{{lumiaPersonality}}` | All selected personality traits | Optional: `{{lumiaPersonality::len}}` to get count |
| `{{lumiaQuirks}}` | Behavioral quirks with mode-adaptive header | — |
| `{{lumiaSelf::N}}` | Self-address pronouns: `1`=my/our, `2`=mine/ours, `3`=me/us, `4`=I/we | Required: `1`, `2`, `3`, or `4` |

Alias: `{{lumiaCouncilQuirks}}` for `{{lumiaQuirks}}`

### Council Status (Condition-Compatible)

| Macro | Returns |
|-------|---------|
| `{{lumiaCouncilModeActive}}` | `"yes"` / `"no"` — whether council mode is on |
| `{{lumiaCouncilToolsActive}}` | `"yes"` / `"no"` — whether council tools ran this generation |

### Council Content

| Macro | Description | Args |
|-------|-------------|------|
| `{{lumiaCouncilInst}}` | Council interaction dynamics prompt with member names | — |
| `{{lumiaCouncilDeliberation}}` | Full tool results and deliberation instructions | — |
| `{{loomCouncilResult::var}}` | A specific named tool result variable | Required: variable name |
| `{{lumiaCouncilToolsList}}` | Tool names with member attribution | — |
| `{{lumiaStateSynthesis}}` | Council Sound-Off / State Synthesis prompt | — |
| `{{lumiaMessageCount}}` | Chat message count (alias for `messageCount`) | — |

### OOC (Out-of-Character)

| Macro | Description |
|-------|-------------|
| `{{lumiaOOC}}` | OOC commentary prompt — adapts for normal, council, and IRC modes |
| `{{lumiaOOCErotic}}` | Mirror & Synapse erotic OOC prompt |
| `{{lumiaOOCEroticBleed}}` | Narrative Rupture mid-narrative OOC prompt |
| `{{lumiaOOCTrigger}}` | OOC trigger countdown or activation message |

---

## Loom

Macros for the Loom narrative system.

### Loom Content

| Macro | Description | Args |
|-------|-------------|------|
| `{{loomStyle}}` | Selected Loom narrative style content | Optional: `{{loomStyle::len}}` to get count |
| `{{loomUtils}}` | Selected Loom utility prompts | Optional: `{{loomUtils::len}}` to get count |
| `{{loomRetrofits}}` | Selected Loom retrofit prompts | Optional: `{{loomRetrofits::len}}` to get count |
| `{{loomSummary}}` | Stored chat summary from Loom summarization | — |
| `{{loomSummaryPrompt}}` | Summarization directive prompt (5-section structure) | — |

### Loom Conversation Aliases

| Macro | Same As |
|-------|---------|
| `{{loomLastUserMessage}}` | `{{lastUserMessage}}` |
| `{{loomLastMessageName}}` | `{{lastMessageName}}` |
| `{{loomLastCharMessage}}` | `{{lastCharMessage}}` |

### Sovereign Hand

| Macro | Description |
|-------|-------------|
| `{{loomSovHandActive}}` | `"yes"` / `"no"` — condition-compatible |
| `{{loomSovHand}}` | Full Sovereign Hand co-pilot prompt |
| `{{loomContinuePrompt}}` | Continuation instructions when Sovereign Hand is active |

---

## Condition-Compatible Macros

These macros return `"yes"` or `"no"` and are designed for use with `{{if}}`:

| Macro | True When |
|-------|-----------|
| `{{isGroupChat}}` | Chat has multiple characters |
| `{{lumiaCouncilModeActive}}` | Council mode is enabled |
| `{{lumiaCouncilToolsActive}}` | Council tools ran this generation |
| `{{loomSovHandActive}}` | Sovereign Hand mode is on |
| `{{memoriesActive}}` | Memories were retrieved |

**Usage:**

```
{{if::{{lumiaCouncilModeActive}}}}
Council deliberation results:
{{lumiaCouncilDeliberation}}
{{/if}}
```

---

## Tips for Preset Creators

!!! tip "Use Dry Run religiously"
    After adding macros to your blocks, always Dry Run to verify they resolve correctly. You'll see the fully assembled prompt with every macro expanded.

!!! tip "Avoid redundancy"
    If you use structural markers (like the `char_description` block), the `{{description}}` macro is already handled. Don't insert both — the same content appears twice.

!!! tip "Conditional blocks save tokens"
    Wrap council-specific content in `{{if::{{lumiaCouncilModeActive}}}}` so it only appears when council is active. Same for group chat content with `{{if::{{isGroupChat}}}}`. This keeps prompts lean.

!!! tip "Variables for state tracking"
    Use `{{setvar}}` and `{{getvar}}` to track story state across turns. For example, track relationship points, quest stages, or discovered secrets. Global variables persist across all chats.

!!! tip "Random adds variety"
    Sprinkle `{{pick}}` into your presets for natural variation: `"Write in a {{pick::vivid::poetic::visceral::atmospheric}} style."` Each generation picks a different word.

!!! tip "Mind the evaluation order"
    Macros are evaluated iteratively (up to 5 passes) in strict left-to-right order. A macro inside another macro's output will be resolved in the next pass. See the [Execution Order](execution-order.md) guide for the complete breakdown — especially important if you're coming from SillyTavern.
