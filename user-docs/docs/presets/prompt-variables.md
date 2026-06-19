# Prompt Variables

Prompt Variables allow preset creators to expose customizable inputs to end users without requiring them to edit raw prompt block text or touch any macros. 

Think of Prompt Variables as a "settings menu" for your preset. If you want users to be able to tweak the character's tone, the verbosity of responses, or specific formatting rules, you can define them as Prompt Variables.

---

## Defining Variables (For Creators)

You can attach variables to any **Prompt Block**. When editing a block in the Preset Editor, scroll to the **Prompt Variables** section and click **Add Variable**.

### Variable Fields

Every variable has core metadata:

- **Name** — The internal ID used in macros (e.g., `tone`). Must be alphanumeric/underscores.
- **Label** — The user-friendly name displayed in the UI (e.g., `Writing Tone`).
- **Description** *(Optional)* — Helper text to explain what the variable does.
- **Default Value** — The fallback value used if the user doesn't provide one.

### Variable Types

You can choose from seven input types, depending on what kind of data your prompt needs:

| Type | Best For | Options |
|------|----------|---------|
| **Text** | Short strings like names, tone descriptors, or simple instructions. | — |
| **Text Area** | Longer paragraphs, like custom formatting rules or lore snippets. | `rows` (controls the height of the input) |
| **Number** | Precise numeric values (e.g., specific repetition counts). | `min`, `max`, `step` |
| **Slider** | Visual range selection (e.g., a "creativity" scale from 1-10). | `min`, `max` (required), `step` |
| **Dropdown** | One-of-many choice where the user picks a short label but a much larger string is substituted into the prompt. | `options` (label + value pairs) |
| **On / Off** | Binary toggle. Resolves to `1` when on, `0` when off — perfect for `{{if::...}}` gates. | — |
| **Multi-select** | Several values at once, concatenated and joined into a single block of text. | `options` (label + value pairs), `separator` (default `\n\n`) |

---

## Dropdown, On/Off, and Multi-select

These three types give your users a curated picker rather than a free-form field, while letting you write the full text that ends up in the prompt.

### Dropdown

A Dropdown shows the user a list of short, friendly labels but substitutes a much larger string in their place. Define each option as a **label + value** pair:

| Label (shown to user) | Value (substituted into prompt) |
|-----------------------|---------------------------------|
| `Warm` | `Respond with empathy, warmth, and emotional attunement.` |
| `Clinical` | `Respond clinically and tersely. Avoid emotive language.` |
| `Playful` | `Respond with light humor and a playful, conversational rhythm.` |

In your block, just write:

```text
{{var::tone}}
```

The user picks `Warm` from the dropdown; the prompt receives the full warm-tone instruction.

### On / Off

An On/Off switch is the simplest possible variable: a single toggle that resolves to `1` (on) or `0` (off). Because `0` is falsy, you can gate entire prompt sections behind it with `{{if::...}}`:

```text
{{if::{{var::strict_canon}}}}
Strictly adhere to established canon. Do not introduce contradictions.
{{/if}}
```

When the user flips `strict_canon` on, the instruction is injected. When it's off, the entire block disappears — no awkward "false" string left in your prompt.

### Multi-select

A Multi-select is a Dropdown that lets the user pick **several** options. The selected values are concatenated together — by default with two newlines between them, but you can set any separator you like.

Define your options the same way as a Dropdown:

| Label | Value |
|-------|-------|
| `Concise` | `Be concise. Prefer short, direct sentences.` |
| `Vivid` | `Use vivid, sensory imagery in scene description.` |
| `Polite` | `Maintain a polite, professional register throughout.` |

In your block:

```text
Style guidelines:
{{var::style_guides}}
```

If the user selects `Concise` and `Vivid`, the prompt receives:

```text
Style guidelines:
Be concise. Prefer short, direct sentences.

Use vivid, sensory imagery in scene description.
```

> **Order is stable.** Selected values are always emitted in the order you declared the options — not the order the user clicked. This means you can reorder options in the editor and have the joined output rearrange automatically.

#### Branching on multi-select state with `ison`

Sometimes you don't just want to *concatenate* the selected values — you want to know **which** options the user picked so you can branch on them.

Multi-select variables support a special sub-syntax:

```text
{{var::name::ison::keyA,keyB,...}}
```

This returns the literal string `"true"` if **every** listed option key is currently selected, otherwise `"false"`. The keys are the option IDs you defined (visible in the editor), not the labels.

This lets you mix concatenated style instructions with conditional sections that fire only for specific combinations:

```text
{{if::{{var::style_guides::ison::vivid}}}}
Lean into atmosphere — describe weather, lighting, and ambient sound.
{{/if}}

{{if::{{var::style_guides::ison::concise,polite}}}}
Even when being polite, keep responses tight. No throat-clearing.
{{/if}}
```

The first `{{if}}` triggers whenever `Vivid` is selected (regardless of what else is). The second only fires when **both** `Concise` and `Polite` are selected together — a true AND match.

Pass an empty key list (`{{var::name::ison::}}`) and `ison` is vacuously `"true"` — useful as a "no specific requirement" guard.

---

## Using Variables in Blocks

Once you've defined a variable, you need to use it in your block's content using macros.

During prompt assembly, user-configured variables are injected directly into the **local variable scope**. This means you can read them just like any other local variable.

If you created a variable named `tone`, all three of these syntaxes will resolve to the user's value:

```text
// Standard macro evaluation
Write in a {{var::tone}} tone.

// Variable macro evaluation
Write in a {{getvar::tone}} tone.

// Shorthand evaluation
Write in a {{.tone}} tone.
```

> **Type-specific behavior:** the shorthand and `{{getvar}}` forms always resolve to the variable's **rendered value** — the option's value string for Dropdowns, `0` or `1` for On/Off switches, and the joined block of selected values for Multi-selects. Use `{{var::name::ison::...}}` (described below) when you need to inspect a multi-select's underlying selection rather than its rendered text.

### Fallback Precedence

If the user hasn't configured a value, Lumiverse falls back safely:
1. First, it looks for the user's saved override for that variable.
2. If none exists, it uses the **Default Value** you declared on the block.
3. If no default exists, it resolves to an empty string.

Because prompt variables are placed in the local variable scope *before* your block is evaluated, you can even mutate them dynamically inside your prompt using `{{setvar}}` or `{{.var = value}}`.

---

## The Prompt Variables Modal (For Users)

When a user selects a preset that contains Prompt Variables, they will see a **Sliders icon** <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><line x1="4" x2="20" y1="21" y2="14"/><line x1="4" x2="20" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="8" x2="8" y1="12" y2="3"/><line x1="16" x2="16" y1="21" y2="16"/><line x1="20" x2="20" y1="16" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="6" x2="10" y1="10" y2="10"/><line x1="14" x2="18" y1="16" y2="16"/></svg> available in the UI. 

Clicking this opens the **Prompt Variables Modal**.

### Intelligent Filtering

The modal aggregates all variables from the preset, but **it only shows variables for blocks that are currently enabled**.

If you disable a prompt block (for instance, turning off a specific "Action Sequences" module), any Prompt Variables attached to that block will disappear from the modal. This ensures users are never confused by settings that are inactive.

### Resetting Values

Users can freely adjust the sliders, text fields, and numeric inputs. If they want to return to the preset creator's original vision, they can click the **Reset to Default** button to instantly restore the `defaultValue` of every variable.