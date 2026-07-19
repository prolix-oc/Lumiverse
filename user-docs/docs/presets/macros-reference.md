---
title: Macros Reference
---

# Macros Reference

Macros are template variables written as `{{macro_name}}` that get replaced with dynamic content when your preset is assembled into a prompt. This is the complete reference of the built-in macros available in Lumiverse.

---

## How to Use Macros

Place macros anywhere in preset blocks, chat-facing prompt fields, and other prompt content that goes through macro evaluation:

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

### Prefixes & Scoped Tags

Lumiverse parses SillyTavern-style macro prefixes. The currently user-relevant ones are:

| Prefix | Syntax | Effect |
|--------|--------|--------|
| `!` | `{{!macro}}` | Parsed for immediate/compatibility-prefixed macros |
| `?` | `{{?macro}}` | Parsed for delayed/compatibility-prefixed macros |
| `~` | `{{~macro}}` | Parsed for reevaluate-style compatibility |
| `>` | `{{>macro}}` | Parsed for filter-style compatibility |
| `#` | `{{#trim}}...{{/trim}}` | Preserve whitespace for macros that support it (`trim` is the main built-in example) |

Closing scoped macros use `/`, like `{{/if}}`, `{{/trim}}`, or `{{/numbered}}`.

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
| `{{// comment text}}` | — | Inline comment shorthand |
| `{{input}}` | — | The raw text of the last user message |
| `{{reverse::text}}` | — | Reverses the given text |
| `{{outlet::name}}` | — | Resolves the content exported by an active world-info entry outlet |
| `{{banned}}` | — | Placeholder for banned token lists |

### Conditional Logic

```
{{if::condition}}
  Content when true
{{else}}
  Content when false
{{/if}}
```

The condition can be any value — it's truthy unless it's empty, `"0"`, `"false"`, `"null"`, `"undefined"`, `"no"`, or `"off"` (case-insensitive for the named falsy values).

Only the selected branch is resolved. Side-effect macros in the unselected branch do not run.

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

**Else-if chains** — use `{{elseif}}` or `{{elif}}` to avoid deeply nested `if` blocks:

```
{{if::{{groupCardMode}} == solo}}
Solo chat rules.
{{elseif::{{groupCardMode}} == swap}}
Focused group-member rules.
{{elseif::{{groupCardMode}} == merge_ignore_muted}}
Merged non-muted group rules.
{{else}}
Merged group rules.
{{/if}}
```

**Unless** — invert a condition at the block level:

```
{{unless::{{isGroupChat}}}}
Only include this in solo chats.
{{else}}
Only include this in group chats.
{{/unless}}
```

**Variable shorthand** — `.var`, `$var`, and `@var` resolve automatically in conditions:

```
{{if .myVar}}has a value{{/if}}
{{if .x > .y}}x is bigger{{/if}}
{{if !.gameOver}}still playing{{/if}}
{{if @hp > 0}}still alive{{/if}}
```

!!! note "Resolution limits"
    Macro resolution is guarded by a work budget rather than a shallow nesting-depth cap. Deep finite macro chains can resolve beyond 1000 levels, but runaway recursion or explosive expansion is stopped with diagnostics. Individual generators such as `{{repeat}}`, `{{range}}`, and iteration macros still cap item counts at 1000 to keep prompt assembly bounded.

---

## Iteration

### `{{foreach}}`

Repeat a block of content once for each item in a list — the macro equivalent of a JavaScript `forEach`. The list is a single string that is split on a delimiter (`,` by default); each item is trimmed and blank items are dropped.

```
{{foreach::apple, banana, cherry}}
- {{.item}}
{{/foreach}}
```

produces:

```
- apple
- banana
- cherry
```

**Custom loop variable** — the second argument renames the loop variable (default `item`):

```
{{foreach::Alice,Bob::name}}{{.name}} is here. {{/foreach}}
```

**Custom delimiter** — the third argument changes the split character. Pass an empty delimiter (`::`) to treat the whole string as a single item:

```
{{foreach::a|b|c::item::|}}{{.item}} {{/foreach}}    — splits on "|"
```

Inside the body, these loop variables are available (replace `item` with your variable name):

| Variable | Value |
|----------|-------|
| `{{.item}}` | The current item |
| `{{.item_index}}` | 0-based position (`0`, `1`, `2`, …) |
| `{{.item_number}}` | 1-based position (`1`, `2`, `3`, …) |
| `{{.item_count}}` | Total number of items |
| `{{.item_first}}` | `"true"` on the first item, otherwise empty |
| `{{.item_last}}` | `"true"` on the last item, otherwise empty |

**Numbered list:**

```
{{foreach::Sword,Shield,Potion::loot}}{{.loot_number}}. {{.loot}}{{newline}}{{/foreach}}
```

**Comma-joined list** — use `{{.x_last}}` to skip the trailing separator:

```
{{foreach::a,b,c::x}}{{.x}}{{if::!{{.x_last}}}}, {{/if}}{{/foreach}}    — "a, b, c"
```

`{{foreach}}` pairs naturally with any macro that returns a delimited list, such as `{{players}}` or `{{group}}`:

```
{{foreach::{{players}}}}- {{.item}}{{newline}}{{/foreach}}
```

!!! note "Good to know"
    - The loop variable is scoped to the loop: its previous value (if any) is restored when the loop ends, so it never clobbers a variable of the same name used elsewhere.
    - Loops can be nested — give the inner loop a different variable name.
    - Iteration is capped at 1000 items.

### `{{range}}`

Generate a numeric sequence as a comma-separated list — ideal for counted loops.

```
{{range::5}}              — "1, 2, 3, 4, 5"   (1..n inclusive)
{{range::3::6}}           — "3, 4, 5, 6"      (start..end inclusive)
{{range::1::10::2}}       — "1, 3, 5, 7, 9"   (with a step)
{{range::5::1}}           — "5, 4, 3, 2, 1"   (counts down)
```

Feed it into `{{foreach}}` for indexed repetition:

```
{{foreach::{{range::1::{{playerCount}}}}::n}}Round {{.n}}…{{newline}}{{/foreach}}
```

### `{{filter}}`

Keep only the list items whose body — an `{{if}}`-style condition — is truthy, returning a comma-separated list. The body sees the same loop variables as `{{foreach}}` (`{{.item}}`, `{{.item_index}}`, …).

```
{{filter::1,2,3,4::n}}{{gt::{{.n}}::2}}{{/filter}}                  — "3, 4"
{{filter::{{players}}::p}}{{ne::{{.p}}::{{hostName}}}}{{/filter}}    — everyone but the host
```

### `{{map}}` / `{{collect}}`

Transform each item in a list and return the transformed values as a delimited list. It uses the same loop bindings and hygiene as `{{foreach}}`.

```
{{map::a,b,c::x}}{{upper::{{.x}}}}{{/map}}          — "A, B, C"
```

Arguments:

| Position | Meaning | Default |
|----------|---------|---------|
| 1 | Input list | Required |
| 2 | Loop variable name | `item` |
| 3 | Input delimiter | `,` |
| 4 | Output delimiter | `, ` |

```
{{map::Alice|Bob|Cara::name::|:: / }}{{.name_number}}={{.name}}{{/map}}
```

produces:

```
1=Alice / 2=Bob / 3=Cara
```

### `{{some}}` / `{{every}}`

Test whether **any** (`{{some}}`) or **all** (`{{every}}`) items satisfy a predicate. Both return `"true"` / `""`, are usable as conditions, and short-circuit. `{{every}}` is vacuously `"true"` for an empty list.

```
{{if::{{some::{{players}}::p}}{{eq::{{.p}}::Bob}}{{/some}}}}Bob is here.{{/if}}
{{if::{{every::{{range::1::5}}::n}}{{gt::{{.n}}::0}}{{/every}}}}all positive{{/if}}
```

### `{{foreachMessage}}`

Loop over the chat history, resolving the body once per message — for custom transcripts, pulling out a speaker's lines, or scanning recent turns.

```
{{foreachMessage}}{{.msg_name}}: {{.msg}}{{newline}}{{/foreachMessage}}
{{foreachMessage::5}}…{{/foreachMessage}}            — only the last 5 messages
{{foreachMessage::5::m}}…{{.m}}…{{/foreachMessage}}  — last 5, body variable "m"
```

A **numeric** first argument iterates the last N messages (oldest-first); a **non-numeric** first argument is the loop variable name (default `msg`). Body bindings (replace `msg`):

| Variable | Value |
|----------|-------|
| `{{.msg}}` | Message content |
| `{{.msg_name}}` | Author name |
| `{{.msg_is_user}}` | `"true"` for a user message, otherwise empty |
| `{{.msg_index}}` / `{{.msg_number}}` / `{{.msg_count}}` | Position and total |
| `{{.msg_first}}` / `{{.msg_last}}` | Edge flags (`"true"` / `""`) |

```
{{foreachMessage::10::m}}{{if::{{.m_is_user}}}}> {{.m}}{{newline}}{{/if}}{{/foreachMessage}}    — the user's recent lines
```

### `{{foreachVar}}` / `{{foreachChatVar}}` / `{{foreachGlobalVar}}`

Loop over the variables in a scope whose name starts with a prefix — the way to render a **dynamic state table** when you don't know the keys ahead of time. `{{foreachVar}}` reads local (`.`) variables, `{{foreachChatVar}}` reads chat-persisted (`@`) variables, and `{{foreachGlobalVar}}` reads global (`$`) variables. Items are visited in alphabetical key order.

```
{{@hp_Alice = 100}}{{@hp_Bob = 80}}
{{foreachChatVar::hp_::p}}{{.p}}: {{.p_value}} HP{{newline}}{{/foreachChatVar}}
```

produces:

```
Alice: 100 HP
Bob: 80 HP
```

Body bindings (replace `item`): `{{.item}}` is the name **after** the prefix, `{{.item_key}}` is the full variable name, `{{.item_value}}` is its value, plus the usual `{{.item_index}}` / `{{.item_number}}` / `{{.item_count}}` / `{{.item_first}}` / `{{.item_last}}`.

---

## Lists

Query and transform comma-separated lists. These compose with the iteration macros and with anything that returns a list (`{{players}}`, `{{group}}`, `{{range}}`). Input is split on commas (items trimmed, blanks dropped); list-returning macros emit a clean `, `-separated list, so the family round-trips.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{count::list}}` | `{{listLength}}` | Number of items |
| `{{includes::list::item}}` | `{{contains}}`, `{{inList}}` | `"true"` / `""` — whole-item membership (condition-compatible) |
| `{{nth::list::i}}` | `{{at}}` | Item at index `i` (0-based; negative counts from the end) |
| `{{first::list}}` | — | First item |
| `{{last::list}}` | — | Last item |
| `{{slice::list::start::end}}` | — | Sublist (`end` exclusive and optional; negatives allowed). `{{slice::list::-3}}` → last 3 |
| `{{take::list::n}}` | — | First `n` items (negative `n` → last `|n|`) |
| `{{sort::list::dir}}` | — | Sorted; numeric when every item is a number, else alphabetical. `dir` = `asc` (default) or `desc` |
| `{{unique::list}}` | `{{dedupe}}`, `{{distinct}}` | Duplicates removed (first occurrence kept) |
| `{{reverseList::list}}` | — | Items in reverse order |
| `{{shuffle::list}}` | — | Items in random order |

**Examples:**

```
{{count::{{players}}}}                        — how many players
{{if::{{includes::{{group}}::Bob}}}}…{{/if}}   — gate on membership
{{first::{{sort::10,2,30}}}}                   — "2" (numeric sort → smallest)
{{slice::{{players}}::-2}}                      — the last two players
{{unique::{{sort::b,a,b,c}}}}                   — "a, b, c"
```

!!! note "Delimiters"
    The Lists macros operate on **comma-separated** lists — the form every list-producing macro emits. To bring in data with another delimiter, parse it through `{{foreach}}`'s delimiter argument or normalise it first with `{{replace}}`.

### Numeric reductions

Reduce a list of numbers to a single value (non-numeric items are ignored).

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{sum::list}}` | — | Total (`0` for an empty list) |
| `{{avg::list}}` | `{{mean}}`, `{{average}}` | Mean (empty when there are no numbers) |
| `{{listMax::list}}` | `{{list_max}}` | Largest number |
| `{{listMin::list}}` | `{{list_min}}` | Smallest number |

```
{{sum::{{range::1::10}}}}                                            — "55"
{{avg::{{foreachChatVar::hp_::p}}{{.p_value}},{{/foreachChatVar}}}}   — average party HP
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
| `{{charGroupFocusedDescription}}` | `{{charFocusedDescription}}`, `{{char_group_focused_description}}` | The focused group character's description |
| `{{charGroupFocusedPersonality}}` | `{{charFocusedPersonality}}`, `{{char_group_focused_personality}}` | The focused group character's personality |
| `{{isGroupChat}}` | `{{is_group_chat}}` | `"yes"` or `"no"` — usable as a condition |
| `{{isNarrator}}` | `{{is_narrator}}` | `"yes"` or `"no"` — whether the active persona is a narrator (not a self-insert) |
| `{{groupOthers}}` | `{{group_others}}` | Group members excluding the focused character |
| `{{groupMemberCount}}` | `{{group_member_count}}` | Number of characters in the group |
| `{{groupLastSpeaker}}` | `{{group_last_speaker}}` | Last character who spoke |
| `{{groupCardMode}}` | `{{group_card_mode}}` | Card composition mode: `"solo"`, `"swap"`, `"merge"`, or `"merge_ignore_muted"` |

---

## Multiplayer

State about the current multiplayer room. Outside a room every macro returns a safe "not multiplayer" value (`{{isMultiplayer}}` → `"no"`, counts → `0`, names → empty), so presets can reference them unconditionally. Names match what you see on messages: a player's persona name if they set one, otherwise their display name.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{isMultiplayer}}` | `{{is_multiplayer}}`, `{{is_multiplayer_room}}` | `"yes"` or `"no"` — usable as a condition |
| `{{playerCount}}` | `{{player_count}}`, `{{players_count}}` | Number of active players (host + peers) |
| `{{players}}` | `{{player_names}}` | Comma-separated names of all active players (host first) |
| `{{hostName}}` | `{{host_name}}` | Display name of the room's host |
| `{{currentPlayer}}` | `{{current_player}}`, `{{current_turn}}` | Name of the player whose turn it is (round-robin rooms; empty in freeform) |

**Gate room-only content** so it costs nothing in solo chats:

```
{{if::{{isMultiplayer}}}}
This is a group session with {{playerCount}} players: {{players}}.
It is currently {{currentPlayer}}'s turn.
{{/if}}
```

**Enumerate the roster** with `{{foreach}}`:

```
{{if::{{isMultiplayer}}}}
Players in the room:
{{foreach::{{players}}::player}}{{.player_number}}. {{.player}}{{newline}}{{/foreach}}
{{/if}}
```

---

## Character Data

Macros that pull from the character card fields. These respect [alternate field](../characters/alternate-fields.md) selections.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{description}}` | `{{charDescription}}` | Character's description |
| `{{personality}}` | `{{charPersonality}}` | Character's personality |
| `{{scenario}}` | `{{charScenario}}` | Character's scenario |
| `{{persona}}` | `{{userPersona}}` | Your persona's description (includes enabled add-ons) |
| `{{sub}}` | `{{subjectivePronoun}}`, `{{personaSubjectivePronoun}}` | Your persona's subjective pronoun |
| `{{obj}}` | `{{objectivePronoun}}`, `{{personaObjectivePronoun}}` | Your persona's objective pronoun |
| `{{poss}}` | `{{possessivePronoun}}`, `{{personaPossessivePronoun}}` | Your persona's possessive pronoun |
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

### Character Tags

Macros that read the current character card's tags — categorical labels such as `Fantasy`, `Warrior`, `OC`, or `Female`.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{charTags}}` | `{{characterTags}}`, `{{char_tags}}`, `{{tags}}` | Comma-separated list of all the character's tags |
| `{{tag::index}}` | `{{tagAt}}`, `{{tag_at}}`, `{{charTagAt}}`, `{{nthTag}}` | Single tag at a 0-based index (negative counts from the end); empty if out of range |
| `{{tagCount}}` | `{{tag_count}}`, `{{tags_count}}`, `{{numTags}}`, `{{charTagCount}}` | Number of tags |
| `{{randomTag}}` | `{{random_tag}}`, `{{randomCharTag}}` | One randomly chosen tag (empty if the character has none) |
| `{{hasTag::name}}` | `{{charTag}}`, `{{char_tag}}`, `{{has_tag}}`, `{{tagged}}` | `"true"` if the character has the tag (case-insensitive), else empty — usable as a condition |

```
{{charTags}}                         — "Fantasy, Warrior, Male"
{{tagCount}}                         — "3"
{{tag::0}}                           — "Fantasy" (first tag)
{{tag::-1}}                          — "Male" (last tag)
{{hasTag::warrior}}                  — "true" (case-insensitive)
{{randomTag}}                        — one of the tags at random

{{if::{{hasTag::villain}}}}The character is a villain.{{/if}}
{{foreach::{{charTags}}::t}}- {{.t}}{{newline}}{{/foreach}}
{{count::{{charTags}}}}              — same as {{tagCount}}
{{includes::{{charTags}}::Warrior}}  — "true"
```

!!! tip "Composing with Lists"
    `{{charTags}}` returns the same clean comma-separated list form used by the [Lists](#lists) macros, so it feeds directly into `{{count}}`, `{{first}}`, `{{includes}}`, `{{foreach}}`, `{{slice}}`, and the rest of the Lists/Iteration family. Use `{{hasTag}}` when you need a condition-friendly gate for tag-specific content. Like the rest of the list family, these macros split on commas, so a tag label that itself contains a comma is treated as two entries.

---

## Chat & Conversation

Macros for the current chat state.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{lastMessage}}` | `{{last_message}}` | Content of the most recent message |
| `{{lastMessageId}}` | `{{last_message_id}}` | Index of the last message |
| `{{lastUserMessage}}` | `{{last_user_message}}` | Content of the last message from you |
| `{{userInput}}` | `{{user_input}}` | Exact input-bar draft captured when the generation began; empty for generations not started from the input bar |
| `{{lastCharMessage}}` | `{{last_char_message}}`, `{{lastBotMessage}}` | Content of the last character message |
| `{{lastMessageName}}` | — | Name of whoever sent the last message |
| `{{messageCount}}` | `{{message_count}}`, `{{messagecount}}` | Total message count in the chat |
| `{{chatId}}` | `{{chat_id}}` | The current chat's unique ID |
| `{{firstIncludedMessageId}}` | — | Index of the first message included in the prompt |
| `{{firstDisplayedMessageId}}` | — | Index of the first displayed message |
| `{{lastSwipeId}}` | — | Index of the last swipe on the final message |
| `{{currentSwipeId}}` | — | Index of the active swipe |
| `{{rejectedSwipe}}` | `{{rejectedGeneration}}`, `{{regeneratedMessage}}` | Content of the regenerate/swipe target before the new swipe was staged; empty otherwise |

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

`{{switch}}` also has a scoped block form for larger branches:

```
{{switch::{{groupCardMode}}}}
{{case::solo}}
Solo chat instructions.
{{/case}}
{{case::swap}}
Focused group-member instructions.
{{/case}}
{{case::merge::merge_ignore_muted}}
Merged group instructions.
{{/case}}
{{default}}
Fallback instructions.
{{/default}}
{{/switch}}
```

Only the matching `{{case}}` body, or the `{{default}}` body, is resolved.

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

### Predicate Helpers

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{empty::value}}` | `{{isEmpty}}` | `"true"` when the value is exactly empty |
| `{{blank::value}}` | `{{isBlank}}` | `"true"` when the value is empty or whitespace-only |
| `{{number::value}}` | `{{isNumber}}`, `{{numeric}}` | `"true"` for finite numbers |
| `{{integer::value}}` | `{{isInteger}}`, `{{int}}` | `"true"` for integer strings |
| `{{matches::text::pattern::flags}}` | — | `"true"` when `text` matches a regex pattern |
| `{{startsWith::text::prefix}}` | `{{starts_with}}` | `"true"` when `text` starts with `prefix` |
| `{{endsWith::text::suffix}}` | `{{ends_with}}` | `"true"` when `text` ends with `suffix` |

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

{{if::{{blank::{{.optional_note}}}}}}
  No note was provided.
{{/if}}

{{if::{{matches::{{lastUserMessage}}::\\bhelp\\b::i}}}}
  The user asked for help.
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

Access individual messages, track state, and query chat metadata.

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{messageAt::index}}` | `{{message_at}}`, `{{msgAt}}` | Message content at index | 0-based index (negative counts from end) |
| `{{messagesBy::name::count}}` | `{{messages_by}}`, `{{msgBy}}` | Last N messages from a speaker | Speaker name, optional count (default 3) |
| `{{chatAge}}` | `{{chat_age}}` | Human-readable time since chat creation | — |
| `{{counter::name}}` | — | Incremented value (1, 2, 3...) | Counter name (stored as local variable) |
| `{{toggle::name}}` | — | Flipped boolean (`"true"` ↔ `"false"`) | Toggle name (stored as local variable) |
| `{{rcounter::name}}` | — | Render-scoped counter (resets each prompt build, never persisted) | Counter name; optional second arg `reset` to zero it |

**Examples:**

```
{{messageAt::0}}                  — the first message (greeting)
{{messageAt::-1}}                 — the most recent message
{{messagesBy::{{char}}::3}}       — last 3 things the character said

{{counter::scene_count}}          — auto-incrementing scene counter
{{toggle::narrator_mode}}         — flip between narrator on/off

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
| `{{let::key::value}}...{{/let}}` | Temporarily bind local variables for the scoped body, then restore previous values | Pairs of name/value arguments |

Aliases: `{{varexists}}` for `{{hasvar}}`, `{{flushvar}}` for `{{deletevar}}`, `{{withVar}}` / `{{scope}}` for `{{let}}`

**Shorthand:** `.` prefix — `{{.myVar}}`, `{{.score = 100}}`, `{{.counter++}}`

**Scoped temporary variables:**

```
{{let::speaker::{{char}}::tone::quiet}}
Write {{.speaker}} with a {{.tone}} voice.
{{/let}}
```

`{{let}}` is hygienic: if a local variable already existed, its previous value is restored after the block; if it did not exist, it is removed after the block.

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

### Prompt Variables (Preset Inputs)

Prompt variables are preset-defined inputs that are seeded into local scope before block evaluation. That means `{{var::tone}}`, `{{getvar::tone}}`, and `{{.tone}}` can all resolve to the same runtime value.

Variables come in seven types — **Text**, **Text Area**, **Number**, **Slider**, **Dropdown**, **On/Off**, and **Multi-select** — and each resolves to its **rendered value** when read:

- **Dropdown** → the selected option's value string (the long, expanded text the creator wrote).
- **On/Off** → `1` when on, `0` when off. Use directly in `{{if::...}}` gates.
- **Multi-select** → the selected options' values, joined by the variable's separator (default `\n\n`).

| Macro | Aliases | Description | Args |
|-------|---------|-------------|------|
| `{{var::name}}` | `{{promptVar}}`, `{{presetVar}}` | Read the runtime prompt-variable value, then the user override, then the creator default | Variable name |
| `{{var::name::ison::keyA,keyB,...}}` | — | **Multi-select only.** Returns `"true"` if every listed option key is currently selected (AND match), `"false"` otherwise. Empty key list is vacuously `"true"`. | Variable name, the literal `ison`, comma-separated option keys |
| `{{hasVar::name}}` | `{{hasPromptVar}}`, `{{hasPresetVar}}` | Check whether a prompt variable is resolvable | Variable name |
| `{{varDefault::name}}` | `{{promptVarDefault}}`, `{{presetVarDefault}}` | Read the creator-declared default only | Variable name |

**Examples:**

```
Tone: {{default::{{var::tone}}::neutral}}

{{if::{{hasPromptVar::violence}}}}
Violence level: {{var::violence}}
{{/if}}

// On/Off switches resolve to 1 or 0 — drop them straight into {{if::...}}.
{{if::{{var::strict_canon}}}}
Strictly adhere to established canon.
{{/if}}

// Multi-select: the rendered value is the joined block of selected option values.
Style guidelines:
{{var::style_guides}}

// Multi-select: branch on WHICH options are selected with the ison sub-syntax.
{{if::{{var::style_guides::ison::concise,polite}}}}
Stay tight and respectful — no throat-clearing.
{{/if}}
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

### Prompt Block Placement

These read-only macros report the **effective placement** of the preset block currently being rendered. If that block uses a [Placement Selector](prompt-variables.md#placement-selector), they reflect the user's saved Dropdown choice; otherwise they reflect the block's ordinary configuration.

| Macro | Aliases | Returns |
|-------|---------|---------|
| `{{promptBlockRole}}` | `{{blockRole}}`, `{{prompt_block_role}}` | Current block role: `system`, `user`, `assistant`, `user_append`, or `assistant_append` |
| `{{promptBlockPosition}}` | `{{blockPosition}}`, `{{prompt_block_position}}` | Current block position: `pre_history`, `post_history`, or `in_history` |
| `{{promptBlockDepth}}` | `{{blockDepth}}`, `{{prompt_block_depth}}` | Current block depth as a number (including `0`) |

They resolve to an empty string outside preset-block rendering, such as in a free-form macro preview. They only report placement; they cannot move or modify a block.

**Example — adapt wording to placement:**

```
{{if::{{promptBlockPosition}} == in_history}}
This is an in-history reminder. Treat it as context attached near the conversation.
{{else}}
This is a top-level instruction block.
{{/if}}

{{if::{{promptBlockRole}} == system}}
Follow these instructions at the system level.
{{/if}}
```

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

Long-term memory and retrieval macros from Lumiverse's memory systems.

### Long-Term Memory

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{memories}}` | `{{longTermMemory}}`, `{{chatMemory}}`, `{{ltm}}` | Formatted memory chunks with header | Optional: `{{memories::count}}` to override chunk count |
| `{{memoriesActive}}` | — | `"yes"` / `"no"` — whether memories were retrieved (condition-compatible) | — |
| `{{memoriesCount}}` | — | Number of memory chunks retrieved | — |
| `{{memoriesRaw}}` | — | Raw memory chunks without header formatting | Optional: `{{memoriesRaw::count}}` to override chunk count |

### Databank Retrieval

| Macro | Aliases | Returns | Args |
|-------|---------|---------|------|
| `{{databank}}` | `{{databankMemory}}`, `{{documents}}`, `{{knowledgeBank}}` | Formatted databank chunks with source headers | Optional: `{{databank::count}}` to override chunk count |
| `{{databankActive}}` | — | `"yes"` / `"no"` — whether databank retrieval returned chunks | — |
| `{{databankCount}}` | — | Number of databank chunks retrieved | — |
| `{{databankRaw}}` | — | Raw databank chunks without the outer header | Optional: `{{databankRaw::count}}` to override chunk count |

### Memory Cortex

| Macro | Returns | Args |
|-------|---------|------|
| `{{entities}}` | Formatted entity snapshots with facts and relationships | Optional: `{{entities::count}}` to limit the number of entities |
| `{{entityFacts::name}}` | Facts for one named entity | Entity name |
| `{{relationships}}` | Active relationship edges in the current scene | — |
| `{{arc}}` | Current narrative arc summary | — |
| `{{memorySalience}}` | Highest-salience retrieved memory | — |
| `{{cortexActive}}` | `"yes"` / `"no"` — whether Memory Cortex returned results | — |
| `{{entityCount}}` | Number of active entities in context | — |
| `{{characterColors}}` | Character speech / thought / narration color instructions | — |

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

These macros return condition-friendly truthy/falsy values (such as `"yes"` / `"no"` or `"true"` / empty) and are designed for use with `{{if}}`:

| Macro | True When |
|-------|-----------|
| `{{isGroupChat}}` | Chat has multiple characters |
| `{{isNarrator}}` | Active persona is marked as a narrator |
| `{{isMultiplayer}}` | Chat is a multiplayer room |
| `{{lumiaCouncilModeActive}}` | Council mode is enabled |
| `{{lumiaCouncilToolsActive}}` | Council tools ran this generation |
| `{{loomSovHandActive}}` | Sovereign Hand mode is on |
| `{{memoriesActive}}` | Memories were retrieved |
| `{{databankActive}}` | Databank retrieval returned chunks |
| `{{cortexActive}}` | Memory Cortex returned results |
| `{{hasvar::key}}` | Local variable exists |
| `{{haschatvar::key}}` | Chat-persisted variable exists |
| `{{hasgvar::key}}` | Global variable exists |
| `{{hasPromptVar::name}}` | A prompt variable is available |
| `{{hasTag::name}}` | Character has the given tag (case-insensitive) |
| `{{var::name::ison::keyA,keyB}}` | All listed option keys are selected on a multi-select prompt variable |
| `{{regexInstalled::id}}` | Regex script with that ID is installed and enabled |
| `{{and::a::b}}` | All arguments are truthy |
| `{{or::a::b}}` | Any argument is truthy |
| `{{not::value}}` | Value is falsy |
| `{{eq::a::b}}` / `{{gt}}` / `{{lt}}` / etc. | Comparison is true |
| `{{includes::list::item}}` | List contains the item |
| `{{some::list::var}}…{{/some}}` | Any list item satisfies the predicate |
| `{{every::list::var}}…{{/every}}` | All list items satisfy the predicate |

**Usage:**

```
{{if::{{lumiaCouncilModeActive}}}}
Council deliberation results:
{{lumiaCouncilDeliberation}}
{{/if}}

{{if::{{and::{{hasTag::fantasy}}::{{gt::{{messageCount}}::5}}}}}}
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

!!! tip "`{{foreach}}` over lists"
    Any macro that returns a comma-separated list — `{{players}}`, `{{group}}`, a `{{.var}}` you built up — can be fed straight into `{{foreach}}`: `{{foreach::{{players}}::p}}{{.p_number}}. {{.p}}{{newline}}{{/foreach}}`. Wrap multiplayer-only content in `{{if::{{isMultiplayer}}}}` so it stays out of solo chats.

!!! tip "Shape lists before you loop"
    The `{{sort}}`, `{{unique}}`, `{{filter}}`, `{{slice}}`, and `{{take}}` macros all return lists, so they chain: `{{foreach::{{unique::{{sort::{{group}}}}}}::name}}…{{/foreach}}` loops a sorted, de-duplicated roster. Use `{{count}}` / `{{includes}}` / `{{some}}` / `{{every}}` to gate on a list without looping at all.

!!! tip "Dynamic state tables"
    Track per-entity state with prefixed chat variables — `{{@hp_Alice = 100}}`, `{{@hp_Bob = 80}}` — then render or aggregate the whole table without hard-coding names: `{{foreachChatVar::hp_::p}}{{.p}}: {{.p_value}}{{newline}}{{/foreachChatVar}}` to list it, or `{{sum::{{foreachChatVar::hp_::p}}{{.p_value}},{{/foreachChatVar}}}}` to total it. Combine with `{{foreachMessage}}` to drive state from the conversation.

!!! tip "`{{wrap}}` for conditional formatting"
    `{{wrap}}` only outputs if the content is non-empty — `{{wrap::(**::**)::{{.note}}}}` produces nothing when the note is unset, avoiding stray delimiters.

!!! tip "`{{calc}}` for dynamic math"
    `{{calc::({{.hp}} / {{.maxHp}}) * 100}}` gives you a health percentage without juggling `setvar`/`addvar` chains.

!!! tip "Random adds variety"
    Sprinkle `{{pick}}` into your presets for natural variation: `"Write in a {{pick::vivid::poetic::visceral::atmospheric}} style."` Each generation picks a different word.

!!! tip "Coming from SillyTavern?"
    Lumiverse supports SillyTavern-style syntax: `{{.var}}` shorthand, space-delimited arguments, `{{if .var}}` conditions, and `!` negation. Your existing presets should work with minimal changes. See the [Execution Order](execution-order.md) guide for any differences.

!!! tip "Mind the evaluation order"
    Macros resolve primarily in one depth-first AST walk, with nested macro output expanded inline and a small outer retry loop for edge cases. State still flows left-to-right: a later setter will not retroactively change an earlier read in the same block. See the [Execution Order](execution-order.md) guide for the complete breakdown.
