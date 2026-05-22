# Execution Order

This guide explains exactly **when** and **how** macros are evaluated during prompt assembly. If you're coming from SillyTavern, pay close attention — Lumiverse does not cache macro results or rely on post-processing to fix ordering issues. What you write is what runs, in the order you write it.

---

## The Big Picture

When you hit send, Lumiverse builds the prompt in a defined sequence. Here's the full pipeline from start to finish:

```
1.  Load character, persona, chat, connection, preset
2.  Resolve alternate field selections (per-chat overrides)
3.  Build the macro environment (all data snapshots taken NOW)
4.  Activate World Info (keyword scan + vector search)
5.  Walk preset blocks in order:
       → Evaluate each block's macros
       → Insert structural content (description, scenario, etc.)
       → Insert chat history (each message macro-evaluated independently)
       → Insert World Info entries at their configured positions
6.  Inject Author's Note at configured depth (macro-evaluated)
7.  Inject utility prompts (continue nudge, impersonation, etc.)
8.  Apply assistant prefill and prompt bias
9.  Apply context filters (HTML stripping, details removal, etc.)
10. Merge sampler parameters (preset → connection → request overrides)
11. Send to AI provider
```

The critical thing to understand: **macro evaluation happens at step 5**, during the block walk. The macro environment is built once at step 3 and reused for every block. World Info is activated at step 4 — *before* any macros run.

---

## How Macro Evaluation Works

### Depth-First With a Small Safety Retry Loop

Lumiverse evaluates macros primarily in a single AST walk, resolving nested macros depth-first and expanding returned macro text inline. A small outer retry loop (up to 2 passes per block) remains as a safety net for edge cases where earlier output depends on state mutated later in the same template:

```
Pass 1: parse the block into an AST
        resolve nested macros depth-first
        expand any macro output that still contains {{...}} inline

Pass 2: only runs if the overall block changed in a way that might expose
        newly-resolvable macros due to state mutations elsewhere in the block
```

Each pass:

1. **Parse** the text into an AST (abstract syntax tree)
2. **Evaluate** every macro left-to-right, depth-first
3. **Expand nested/returned macro text inline** where possible
4. **Retry once** only if the block still changed in a way that could matter

This means most nested macro chains collapse in one pass, while still preserving deterministic left-to-right state flow.

!!! warning "Coming from SillyTavern"
    Lumiverse does not reorder macros to make later side effects visible earlier in the same block. If you put `{{getvar::key}}` before `{{setvar::key::value}}`, the read still happens first and gets the previous value (or empty). Branching macros like `{{if}}` and `{{switch}}` now resolve only the selected branch, so side effects in unchosen branches do not run.

### Left-to-Right, Depth-First

Within a single pass, macros are resolved in reading order — left to right, top to bottom. Nested macros (macros inside macro arguments) are resolved before the outer macro runs.

```
{{setvar::greeting::Hello}} {{getvar::greeting}}
           ↑ runs first                ↑ runs second, gets "Hello"
```

```
{{pick::{{getvar::option_a}}::{{getvar::option_b}}::{{getvar::option_c}}}}
        ↑ resolved first     ↑ then this          ↑ then this
                    ↑ then pick runs with the three resolved values
```

### No Result Caching

Every `{{user}}` call re-runs the handler. Every `{{random::1::100}}` gives a new number. Every `{{getvar::key}}` reads the current value. Nothing is cached between uses within the same block or across blocks.

If you call `{{random::1::100}}` twice in the same block, you'll get two different numbers. If you need the same random number in multiple places, store it in a variable:

```
{{setvar::today_roll::{{random::1::100}}}}
You rolled a {{getvar::today_roll}}. That's right, {{getvar::today_roll}}.
```

---

## Block Processing Order

Blocks are processed in the order they appear in your preset's `prompt_order`. For each enabled block, the assembly service does one of these:

### Content Blocks (Custom Text)

Your block's `content` field is run through the macro evaluator. The resolved text becomes a message in the prompt with the block's configured `role`.

```
Block: "You are {{char}}. {{description}}"
  → Evaluate macros
  → Result: "You are Aria. A curious adventurer..."
  → Add as system message
```

### Structural Markers

Blocks with markers like `char_description`, `char_personality`, `scenario`, etc. don't have their own content — they pull from the character card via the corresponding macro (`{{description}}`, `{{personality}}`, `{{scenario}}`). The macro is evaluated the same way as any content block.

### Chat History Marker

The `chat_history` block inserts all chat messages. **Each message is independently macro-evaluated** — macros in one message don't affect the evaluation of the next message (except through variable side effects).

### World Info Markers

The `world_info_before` and `world_info_after` markers inject activated World Info entries. Activated entry content is macro-evaluated before injection, just like other prompt content.

### Disabled Blocks

Skipped entirely. No evaluation, no output. This is also how [Preset Profiles](preset-profiles.md) work — they toggle blocks on/off per context.

### Injection Triggers

If a block has `injectionTrigger` set (e.g., only `["continue", "regenerate"]`), it's skipped for generation types not in that list. An empty trigger list means the block is always included.

---

## When Things Happen (Detailed Timeline)

Here's the precise sequence with annotations for what data is available at each step:

### Step 1-2: Data Loading

Character, persona, preset, connection, and chat are loaded from the database. Alternate field selections are resolved — if you've selected an alternate description for this chat, the character's description is swapped before anything else happens.

### Step 3: Macro Environment Built

A snapshot of all data is taken and stored in the macro environment. This is the data macros will read from:

- `{{char}}`, `{{user}}`, `{{group}}` — Names are frozen here
- `{{description}}`, `{{personality}}`, `{{scenario}}` — Character fields (with alternates applied)
- `{{persona}}` — Persona description with enabled add-ons appended
- `{{lastMessage}}`, `{{messageCount}}` — Chat state at this moment
- `{{model}}`, `{{maxContext}}` — Connection/model info
- Prompt Variables — End-user configured inputs are seeded into the local variable scope
- Variables — Local and global variable maps are loaded

!!! info "Snapshot semantics"
    The environment is built **once**. If a macro modifies a variable with `{{setvar}}`, subsequent macros in the same or later blocks will see the new value (variables are live references). But character/persona/chat data is a snapshot — it won't change mid-assembly.

### Step 4: World Info Activation

All world book entries (character-attached, persona-attached, global) are collected and run through the activation pipeline:

1. Keyword scan against recent messages
2. Selective logic (AND/NOT/OR)
3. Probability rolls
4. Delay/sticky/cooldown state
5. Group competition
6. Priority sorting
7. Budget enforcement (entry cap, token budget)

**This happens before any blocks are processed.** The activated entries are bucketed by position (before, after, depth, etc.) and held ready for injection.

World info content is macro-evaluated before injection. That means `{{char}}`, `{{if}}`, variables, and outlet references can resolve inside activated entries.

### Step 5: Block Walk

Blocks are processed in order. For each block:

1. Check if enabled → skip if not
2. Check injection trigger → skip if generation type doesn't match
3. Evaluate the block's content through the macro evaluator
4. Add the result to the prompt as a message with the block's role

World info entries are injected when their marker block (`world_info_before` or `world_info_after`) is reached. If no explicit marker blocks exist, entries are auto-injected at default positions after the block loop.

Chat messages are inserted when the `chat_history` marker block is reached.

### Step 6: Author's Note

After all blocks are processed, the Author's Note (if set) is:

1. Macro-evaluated
2. Inserted at `result.length - depth` position in the message list

### Step 7-8: Utility Prompts

These are injected last:

- **Continue nudge** — Instructions for continuation generation
- **Impersonation prompt** — Instructions when AI writes as the user
- **Assistant prefill** — Text to start the AI's response with
- **Prompt bias** — Prefix for influencing generation
- **Regen feedback** — User feedback on why they're regenerating

All of these are macro-evaluated.

### Step 9: Context Filters

Applied to chat history messages after everything else:

- **HTML tag stripping** — Removes formatting tags from older messages
- **Details block removal** — Strips `<details>` from older messages
- **Loom tag removal** — Strips loom-related tags from older messages

Each filter has a `keepDepth` — messages within that many from the end are untouched.

---

## Variable Side Effects Across Blocks

Since blocks are evaluated sequentially with a shared environment, variable macros have predictable cross-block behavior:

```
Block 1 (system): {{setvar::scene_count::0}}

Block 2 (system): Scene count is {{getvar::scene_count}}
                   → "Scene count is 0"

Block 3 (system): {{incvar::scene_count}}
                   Scene count is now {{getvar::scene_count}}
                   → "Scene count is now 1"
```

Variables modified in one block are visible to all subsequent blocks. This is **deterministic** — there's no caching or lazy evaluation that might reorder things.

---

## Conditional Evaluation

The `{{if}}` macro evaluates its condition, then returns only the matching branch:

```
{{if::{{isGroupChat}}}}
Group members: {{group}}
{{else}}
Private chat with {{char}}
{{/if}}
```

### Condition Rules

A condition is **truthy** unless it's one of: `""` (empty), `"0"`, `"false"`, `"null"`, `"undefined"`.

Comparison operators work inside conditions:

| Operator | Example | Notes |
|----------|---------|-------|
| `==` | `{{if::{{messageCount}} == 10}}` | Numeric if both sides are numbers, string otherwise |
| `!=` | `{{if::{{user}} != Guest}}` | |
| `>` | `{{if::{{messageCount}} > 5}}` | Numeric comparison |
| `>=` | `{{if::{{getvar::hp}} >= 0}}` | |
| `<` | `{{if::{{random::1::100}} < 30}}` | |
| `<=` | `{{if::{{getvar::trust}} <= 50}}` | |

### Branch Evaluation

**Only the selected branch is resolved.** The `{{if}}` macro delays evaluation of its body, checks the condition, and then resolves only the matching branch. This means side-effect macros (like `{{setvar}}`) in the discarded branch **do not run**.

```
{{if::{{isGroupChat}}}}
{{.greeting = Welcome everyone!}}
{{else}}
{{.greeting = Hello {{char}}!}}
{{/if}}

{{.greeting}} // Safely outputs the correct greeting without side-effect collisions
```

---

## Nesting Limits

| Limit | Value | What Happens |
|-------|-------|-------------|
| **Max evaluation passes** | 5 | Evaluation stops; remaining `{{` are left as literal text |
| **Max nesting depth** | 20 | Error diagnostic; deeply nested macro returns empty string |
| **AST cache** | 32 entries | Oldest cached parse tree is evicted (LRU) — performance only, no behavioral impact |

If you hit the 5-pass limit, your macros are likely producing infinite recursion (macro A outputs macro B which outputs macro A). Simplify the chain.

---

## Differences from SillyTavern

If you're porting presets from SillyTavern, here are the behaviors that will trip you up:

| Behavior | SillyTavern | Lumiverse |
|----------|-------------|-----------|
| **Evaluation passes** | Single pass + post-processing cleanup | Depth-first AST evaluation with inline expansion and a small retry loop |
| **Result caching** | Macro results can be cached within a pass | No caching — every call re-evaluates |
| **Execution order** | Post-processing can reorder/fix issues | Strict left-to-right, top-to-bottom |
| **World info macros** | Entries are macro-evaluated | Entries are macro-evaluated before injection |
| **`{{random}}`** | May return same value if cached | Always returns a fresh value per call |
| **Side effects** | May be smoothed by caching | Immediate and visible to subsequent macros |
| **Error handling** | Varies | Unknown macros pass through as literal `{{name}}` text |
| **Legacy syntax** | Varies | `<USER>`, `<BOT>`, `<CHAR>` auto-converted |

### Practical Migration Tips

1. **Don't rely on ordering tricks.** If Block A sets a variable and Block B reads it, Block A must come first in the preset order. No exceptions.

2. **Store random values.** If you use `{{random}}` and need the same value in multiple places, `{{setvar}}` it first.

3. **World info is dynamic.** Activated world book entries are macro-evaluated in Lumiverse, so `{{char}}`, variables, and conditional logic can resolve inside entry content.

4. **Test with Dry Run.** Lumiverse's Dry Run shows you the fully assembled prompt with every macro resolved. Use it obsessively when porting presets.

5. **Only the selected conditional branch runs.** Side-effect macros inside the unchosen branch of `{{if}}` or `{{switch}}` do not execute.

6. **Nested expansion still works.** You can build macro names dynamically (`{{getvar::note_{{user}}}}`), and Lumiverse will usually collapse the chain inline during the same evaluation, with one retry pass available for edge cases.
