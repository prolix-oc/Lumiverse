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

Some macros accept arguments, separated by `::` (double colon) **or spaces**:

```
{{random::1::100}}          — random number between 1 and 100
{{pick::cat::dog::bird}}    — randomly selects one item
{{roll::2d6}}               — rolls two six-sided dice
```

**Space-delimited arguments** are also supported — each word becomes a separate argument:

```
{{upper hello}}             — same as {{upper::hello}}
{{setvar key value}}        — same as {{setvar::key::value}}
{{abs -5}}                  — same as {{abs::-5}}
```

!!! tip "When to use `::` vs spaces"
    Use **spaces** for quick single-word arguments: `{{upper hello}}`, `{{floor 3.7}}`.
    Use **`::`** when an argument contains spaces: `{{replace::hello world::goodbye world::text}}`.
    You can mix both: `{{setvar key::long value with spaces}}`.

### Variable Shorthand

Access variables directly with `.` (local), `$` (global), or `@` (chat-persisted) prefixes:

```
{{.myVar}}                  — same as {{getvar::myVar}}
{{$theme}}                  — same as {{getgvar::theme}}
{{@hp}}                     — same as {{getchatvar::hp}}
{{.score = 100}}            — same as {{setvar::score::100}}
{{@hp = 100}}               — same as {{setchatvar::hp::100}}
{{.hp -= 25}}               — subtract 25 from hp
{{.counter++}}              — increment by 1
{{@turn++}}                 — increment a persisted counter
{{.counter--}}              — decrement by 1
```

Variable shorthands work inside conditions too:

```
{{if .myVar}}has a value{{/if}}
{{if .score == 100}}perfect!{{/if}}
{{if !.gameOver}}still playing{{/if}}
{{if $theme == dark}}dark mode{{/if}}
{{if @hp > 0}}still alive{{/if}}
```

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

The condition can be any value — it's truthy unless it's empty, `"0"`, `"false"`, `"null"`, or `"undefined"`.

**Negation** — prefix with `!` to invert:

```
{{if::!0}}yes{{/if}}                — "yes" (0 is falsy, negated → truthy)
{{if::!{{hasvar::key}}}}missing{{/if}}
```

**Comparisons** — use `==`, `!=`, `>`, `<`, `>=`, `<=` inside the condition:

```
{{if::{{messageCount}} > 10}}long chat{{/if}}
{{if::{{.score}} == 100}}perfect!{{/if}}
```

**Variable shorthand** — `.var` and `$var` resolve automatically in conditions:

```
{{if .myVar}}has a value{{/if}}
{{if .x > .y}}x is bigger{{/if}}
{{if !.gameOver}}still playing{{/if}}
```

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

## String Manipulation

Transform, measure, and extract from text.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{len::text}}` | `{{length}}` | Character count | Text (or scoped: `{{len}}text{{/len}}`) |
| `{{upper::text}}` | `{{uppercase}}`, `{{toUpper}}` | Uppercased text | Text (or scoped) |
| `{{lower::text}}` | `{{lowercase}}`, `{{toLower}}` | Lowercased text | Text (or scoped) |
| `{{capitalize::text}}` | `{{titlecase}}` | First letter capitalized | Text (or scoped) |
| `{{replace::find::with::text}}` | — | Text with replacements | Find, replacement, source (or scoped body) |
| `{{substr::text::start::end}}` | `{{substring}}` | Substring | Source, start index, optional end index |
| `{{split::text::delimiter::index}}` | — | Nth item from split | Source, delimiter, 0-based index (negative from end) |
| `{{join::sep::a::b::...}}` | — | Joined string | Separator, then items |
| `{{repeat::N::text}}` | — | Repeated text | Count (max 1000), text (or scoped) |
| `{{wrap::prefix::suffix::text}}` | — | Wrapped text (empty if text is empty) | Prefix, suffix, text (or scoped) |
| `{{regex::pattern::replacement::text}}` | — | Regex-replaced text | Pattern, replacement, text (or scoped), optional flags |
| `{{tokenCount::text}}` | `{{token_count}}`, `{{tokens}}` | Approximate token count | Text (or scoped) |
| `{{truncate::text::maxTokens}}` | — | Truncated text (word-boundary, adds `...`) | Text, max tokens |

**Examples:**

```
{{upper::{{char}}}}                     — "BOB"
{{len::{{description}}}}                — "234" (character count)
{{replace::they::she::{{persona}}}}     — pronoun swap
{{split::{{charTags}}::,::0}}           — first tag
{{join::, ::{{char}}::{{user}}}}        — "Bob, Alice"
{{repeat::3}}---{{newline}}{{/repeat}}  — three separator lines
{{wrap::(**::**)::{{.note}}}}           — "(**important**)" or "" if empty
{{regex::\b(he|him)\b::she/her::{{description}}}}
```

---

## Math

Arithmetic without intermediate variable gymnastics.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{calc::expression}}` | `{{math}}`, `{{evaluate}}` | Result of `+ - * / % ()` | Expression string |
| `{{min::a::b::...}}` | — | Smallest number | Two or more numbers |
| `{{max::a::b::...}}` | — | Largest number | Two or more numbers |
| `{{clamp::value::min::max}}` | — | Value clamped to range | Value, floor, ceiling |
| `{{abs::value}}` | — | Absolute value | Number |
| `{{floor::value}}` | — | Rounded down | Number |
| `{{ceil::value}}` | — | Rounded up | Number |
| `{{round::value::decimals}}` | — | Rounded to N decimal places | Number, optional decimal count (default 0) |
| `{{mod::a::b}}` | — | Remainder of a / b | Dividend, divisor |

**Examples:**

```
{{calc::{{messageCount}} * 2 + 1}}      — arithmetic with macros
{{calc::({{.hp}} / {{.maxHp}}) * 100}}   — health percentage
{{clamp::{{.score}}::0::100}}            — keep score in bounds
{{max::{{.str}}::{{.dex}}}}              — highest stat
{{round::3.14159::2}}                    — "3.14"
```

!!! note "Safe evaluator"
    `{{calc}}` uses a sandboxed arithmetic parser — no `eval()`. Supports `+`, `-`, `*`, `/`, `%`, parentheses, unary minus, and decimal numbers. Division by zero returns `0`.

---

## Logic & Comparisons

Composable boolean logic and multi-branch conditionals.

### Branching

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{switch::value::c1::r1::c2::r2::default}}` | — | Matching result, or default | Value, then case/result pairs, optional default |
| `{{default::value::fallback}}` | `{{fallback}}`, `{{coalesce}}` | First truthy value | Primary value, fallback |

### Boolean Operators

| Macro | Returns | Args |
|-------|---------|------|
| `{{and::a::b::...}}` | `"true"` if all args truthy, else `""` | Two or more values |
| `{{or::a::b::...}}` | `"true"` if any arg truthy, else `""` | Two or more values |
| `{{not::value}}` | `"true"` if value is falsy, else `""` | One value |

### Comparison Operators

| Macro | Returns |
|-------|---------|
| `{{eq::a::b}}` | `"true"` if equal (numeric-aware) |
| `{{ne::a::b}}` | `"true"` if not equal |
| `{{gt::a::b}}` | `"true"` if a > b |
| `{{lt::a::b}}` | `"true"` if a < b |
| `{{gte::a::b}}` | `"true"` if a >= b |
| `{{lte::a::b}}` | `"true"` if a <= b |

**Examples:**

```
{{switch::{{.mood}}::happy::😊::sad::😢::neutral}}

{{default::{{.title}}::Stranger}}

{{if::{{and::{{isGroupChat}}::{{lumiaCouncilModeActive}}}}}}
  Group council is active.
{{/if}}

{{if::{{gt::{{messageCount}}::50}}}}
  This is a long conversation.
{{/if}}
```

!!! tip "`switch` vs nested `if`"
    Instead of chaining `{{if}}...{{else}}{{if}}...` for multiple cases, use `{{switch}}`. It's cleaner and easier to read.

---

## Formatting

Quick list formatting.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{bullets::item1::item2::...}}` | — | `- item1\n- item2\n...` | Items via args, or newline-split body if scoped |
| `{{numbered::item1::item2::...}}` | `{{ol}}`, `{{enumerate}}` | `1. item1\n2. item2\n...` | Items via args, or newline-split body if scoped |

**Examples:**

```
{{bullets::{{char}}::{{user}}::{{group}}}}
{{numbered}}
Establish the scene
Describe the character's action
Include internal thoughts
{{/numbered}}
```

---

## Chat Utilities

Access individual messages, track state, and query character metadata.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{messageAt::index}}` | `{{message_at}}`, `{{msgAt}}` | Message content at index | 0-based index (negative counts from end) |
| `{{messagesBy::name::count}}` | `{{messages_by}}`, `{{msgBy}}` | Last N messages from a speaker | Speaker name, optional count (default 3) |
| `{{chatAge}}` | `{{chat_age}}` | Human-readable time since chat creation | — |
| `{{counter::name}}` | — | Incremented value (1, 2, 3...) | Counter name (stored as local variable) |
| `{{toggle::name}}` | — | Flipped boolean (`"true"` ↔ `"false"`) | Toggle name (stored as local variable) |
| `{{charTags}}` | `{{char_tags}}`, `{{characterTags}}` | Comma-separated list of the character's tags | — |
| `{{charTag::tag}}` | `{{char_tag}}`, `{{hasTag}}`, `{{has_tag}}` | `"true"` / `"false"` — whether character has this tag | Tag name (case-insensitive) |

**Examples:**

```
{{messageAt::0}}                  — the first message (greeting)
{{messageAt::-1}}                 — the most recent message
{{messagesBy::{{char}}::3}}       — last 3 things the character said

{{counter::scene_count}}          — auto-incrementing scene counter
{{toggle::narrator_mode}}         — flip between narrator on/off

{{if::{{charTag::fantasy}}}}
Include world-building details.
{{/if}}

This chat started {{chatAge}} ago.
```

---

## Regex Script References

Call installed regex scripts by their **Script ID** — a stable, user-defined identifier you set on any regex script.

Script IDs are auto-normalized: lowercase, spaces/hyphens become underscores, punctuation stripped. `"My Cool-Script!"` becomes `my_cool_script`.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{regexInstalled::scriptId}}` | `{{regex_installed}}`, `{{hasRegex}}`, `{{has_regex}}` | `"true"` / `"false"` — whether the script exists and is enabled | Script ID only |
| `{{regexInstalled::scriptId::text}}` | — | Text with the regex applied (unchanged if script missing) | Script ID + text (or scoped body) |

**Examples:**

```
{{!-- Check if a script is installed --}}
{{if::{{regexInstalled::censor}}}}
  Content filtering is active.
{{/if}}

{{!-- Apply a regex script inline --}}
{{regexInstalled::fix_pronouns::{{description}}}}

{{!-- Scoped form --}}
{{regexInstalled::format_dialogue}}
  "Hello," she said. "How are you?"
{{/regexInstalled}}
```

!!! tip "Setting a Script ID"
    Open any regex script in the Regex Scripts panel and fill in the **Script ID** field. This is the identifier you use in `{{regexInstalled}}`. Keep it short and descriptive — e.g., `censor`, `fix_pronouns`, `format_dialogue`.

---

## Variables

Read and write values in three scopes — **local** (transient per-evaluation), **chat** (persisted per-chat), or **global** (cross-chat).

### Local Variables (Transient)

Local variables live for the duration of a single evaluation pass. They are useful for intermediate calculations, loop counters, and temporary values within a preset block. They are **not** saved between generations.

| Macro | Description | Args |
|-------|-------------|------|
| `{{getvar::key}}` | Get a variable's value | Variable name |
| `{{setvar::key::value}}` | Set a variable (returns nothing) | Name and value |
| `{{addvar::key::value}}` | Add a number to a variable | Name and number |
| `{{incvar::key}}` | Increment by 1 (returns new value) | Variable name |
| `{{decvar::key}}` | Decrement by 1 (returns new value) | Variable name |
| `{{hasvar::key}}` | Check if variable exists (`"true"` / `"false"`) | Variable name |
| `{{deletevar::key}}` | Delete a variable | Variable name |

Aliases: `{{varexists}}` for `{{hasvar}}`, `{{flushvar}}` for `{{deletevar}}`

**Shorthand:** `.` prefix — `{{.myVar}}`, `{{.score = 100}}`, `{{.counter++}}`

### Chat-Persisted Variables

Chat-persisted variables are **automatically saved** to the chat after each generation. They survive across messages, regenerations, and page reloads — making them ideal for tracking story state like health, quest progress, relationship points, or turn counters.

| Macro | Description | Args |
|-------|-------------|------|
| `{{getchatvar::key}}` | Get a persisted variable's value | Variable name |
| `{{setchatvar::key::value}}` | Set a persisted variable (returns nothing) | Name and value |
| `{{addchatvar::key::value}}` | Add a number to a persisted variable (returns new value) | Name and number |
| `{{incchatvar::key}}` | Increment by 1 (returns new value) | Variable name |
| `{{decchatvar::key}}` | Decrement by 1 (returns new value) | Variable name |
| `{{haschatvar::key}}` | Check if exists (`"true"` / `"false"`) | Variable name |
| `{{deletechatvar::key}}` | Delete a persisted variable | Variable name |

Alias: `{{flushchatvar}}` for `{{deletechatvar}}`

**Shorthand:** `@` prefix — `{{@hp}}`, `{{@hp = 100}}`, `{{@turn++}}`, `{{@hp -= 25}}`

!!! tip "When to use `@` vs `.`"
    Use **`@` (chat-persisted)** for anything that should survive between messages — HP, quest stages, relationship scores, turn counters, discovered secrets.

    Use **`.` (local)** for scratch values within a single evaluation — loop counters, intermediate calculations, temporary formatting state.

**Example — RPG state tracking:**

```
{{@turn++}}
{{@hp -= {{roll::1d6}}}}

{{if::{{gt::{{@hp}}::0}}}}
Turn {{@turn}}: {{char}} takes damage. HP: {{@hp}}/{{@maxHp}}
{{else}}
Turn {{@turn}}: {{char}} has fallen!
{{/if}}
```

**Example — Relationship tracker:**

```
{{setchatvar::affection::50}}

{{if::{{gt::{{@affection}}::80}}}}
{{char}} looks at you warmly.
{{else}}
{{char}} gives you a polite nod.
{{/if}}
```

`setchatvar` also supports scoped syntax — the enclosed content becomes the value:

```
{{setchatvar::last_scene}}The group arrived at the ancient temple...{{/setchatvar}}
```

### Global Variables (Cross-Chat)

Global variables persist across all chats for the current user. Useful for preferences, themes, or cross-character state.

| Macro | Description | Args |
|-------|-------------|------|
| `{{getgvar::key}}` | Get a global variable | Variable name |
| `{{setgvar::key::value}}` | Set a global variable | Name and value |
| `{{addgvar::key::value}}` | Add a number to a global variable | Name and number |
| `{{incgvar::key}}` | Increment by 1 (returns new value) | Variable name |
| `{{decgvar::key}}` | Decrement by 1 (returns new value) | Variable name |
| `{{hasgvar::key}}` | Check if exists (`"true"` / `"false"`) | Variable name |
| `{{deletegvar::key}}` | Delete a global variable | Variable name |

Aliases: `{{getglobalvar}}`, `{{setglobalvar}}`, `{{addglobalvar}}`, `{{incglobalvar}}`, `{{decglobalvar}}`, `{{hasglobalvar}}`, `{{gvarexists}}`, `{{flushgvar}}`, `{{flushglobalvar}}`, `{{deleteglobalvar}}`

**Shorthand:** `$` prefix — `{{$theme}}`, `{{$theme = dark}}`

### Variable Scope Summary

| Scope | Prefix | Persists? | Storage | Use Case |
|-------|--------|-----------|---------|----------|
| Local | `.` | No — one evaluation only | In-memory | Temp calculations, loop counters |
| Chat | `@` | Yes — across generations | `chat.metadata` | HP, quests, turns, story state |
| Global | `$` | Yes — across all chats | User settings | Preferences, cross-character state |

**Example — Combined usage:**

```
{{.roll = {{roll::1d20}}}}
{{@hp -= {{.roll}}}}
Rolled {{.roll}} damage. {{char}}'s HP: {{@hp}}/{{@maxHp}}
```

Here `.roll` is a temporary local variable (used for the current evaluation only), while `@hp` and `@maxHp` are chat-persisted and carry over to the next generation.

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

These macros return `"yes"` / `"no"` or `"true"` / `"false"` and are designed for use with `{{if}}`:

| Macro | True When |
|-------|-----------|
| `{{isGroupChat}}` | Chat has multiple characters |
| `{{lumiaCouncilModeActive}}` | Council mode is enabled |
| `{{lumiaCouncilToolsActive}}` | Council tools ran this generation |
| `{{loomSovHandActive}}` | Sovereign Hand mode is on |
| `{{memoriesActive}}` | Memories were retrieved |
| `{{hasvar::key}}` | Local variable exists |
| `{{haschatvar::key}}` | Chat-persisted variable exists |
| `{{hasgvar::key}}` | Global variable exists |
| `{{charTag::tag}}` | Character has the specified tag |
| `{{regexInstalled::id}}` | Regex script with that ID is installed and enabled |
| `{{and::a::b}}` | All arguments are truthy |
| `{{or::a::b}}` | Any argument is truthy |
| `{{not::value}}` | Value is falsy |
| `{{eq::a::b}}` / `{{gt}}` / `{{lt}}` / etc. | Comparison is true |

**Usage:**

```
{{if::{{lumiaCouncilModeActive}}}}
Council deliberation results:
{{lumiaCouncilDeliberation}}
{{/if}}

{{if::{{and::{{charTag::fantasy}}::{{gt::{{messageCount}}::5}}}}}}
The adventure is well underway.
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
    Use **`@` variables** to track story state that persists across messages — `{{@hp = 100}}`, `{{@turn++}}`, `{{@quest_stage = 2}}`. These are automatically saved after each generation. Use `.` variables for temporary calculations within a single evaluation. Global variables (`{{$var}}`) persist across all chats.

!!! tip "`{{default}}` replaces common if/else patterns"
    Instead of `{{if::{{hasvar::title}}}}{{.title}}{{else}}Stranger{{/if}}`, just write `{{default::{{.title}}::Stranger}}`. Cleaner and shorter.

!!! tip "`{{switch}}` for multi-branch logic"
    Instead of nested if/else chains, use `{{switch::{{.mood}}::happy::cheerful tone::sad::somber tone::neutral tone}}`.

!!! tip "`{{wrap}}` for conditional formatting"
    `{{wrap}}` only outputs if the content is non-empty — `{{wrap::(**::**)::{{.note}}}}` produces nothing when the note is unset, avoiding stray delimiters.

!!! tip "`{{calc}}` for dynamic math"
    `{{calc::({{.hp}} / {{.maxHp}}) * 100}}` gives you a health percentage without juggling `setvar`/`addvar` chains.

!!! tip "Random adds variety"
    Sprinkle `{{pick}}` into your presets for natural variation: `"Write in a {{pick::vivid::poetic::visceral::atmospheric}} style."` Each generation picks a different word.

!!! tip "Coming from SillyTavern?"
    Lumiverse supports SillyTavern-style syntax: `{{.var}}` shorthand, space-delimited arguments, `{{if .var}}` conditions, and `!` negation. Your existing presets should work with minimal changes. See the [Execution Order](execution-order.md) guide for any differences.

!!! tip "Mind the evaluation order"
    Macros are evaluated iteratively (up to 5 passes) in strict left-to-right order. A macro inside another macro's output will be resolved in the next pass. See the [Execution Order](execution-order.md) guide for the complete breakdown.
