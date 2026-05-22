# Bindings & Add-Ons

Beyond basic persona setup, Lumiverse offers several power features: **character bindings** and **tag bindings** that auto-activate personas, and **add-ons** that let you toggle extra persona content on and off.

---

## Character-Persona Bindings

You can bind a persona to a specific character so that persona automatically activates whenever you open a chat with that character.

### Setting Up a Binding

1. Open the **Persona** panel
2. Select the persona you want to bind
3. Click **Bind to Character**
4. Choose the character from the list

Now, whenever you open a chat with that character, your persona switches automatically. Optionally, the binding can also remember a custom set of **add-on toggles** to apply each time it fires (see below).

### How Bindings Work

- Bindings are stored as a setting (`characterPersonaBindings`) — a mapping of character IDs to either a persona ID or `{ personaId, addonStates }`
- When you open a chat, Lumiverse checks if the character has a binding and switches your active persona
- If you manually switch personas in a chat, that overrides the binding for that session
- Deleting a persona automatically cleans up its bindings

### Use Cases

- Bind your "Fantasy Knight" persona to fantasy characters
- Bind your "Modern Self" persona to slice-of-life characters
- Bind a specific persona to a character that expects a particular partner

---

## Persona Tag Bindings

If you don't want to bind every character one-by-one, you can bind a persona to a set of **character tags** and have it auto-activate whenever the chat's active character matches those tags.

### Setting Up a Tag Binding

1. Open the **Persona** panel and select the persona
2. Open the persona editor and find the **Tag Binding** section
3. Enter one or more character tags (e.g. `fantasy`, `medieval`, `oc`)
4. Choose a match mode:
    - **Any** — activate when the character has *any* of the listed tags
    - **All** — activate only when the character has *every* listed tag

When you open a chat with a character that matches, the persona switches automatically. Direct character bindings take priority over tag bindings if both match.

### Ambiguity

If multiple personas match the same character through tag bindings, Lumiverse surfaces the ambiguity in the persona switcher so you can pick the right one — it won't silently choose. Add a direct character binding to disambiguate permanently.

### Use Cases

- Tag all your "modern" characters with `modern` and bind your everyday persona to that tag
- Use a `villain-pov` tag for chats where you want to roleplay as the antagonist

---

## Persona Add-Ons

Add-ons are optional, toggleable content blocks attached to a persona. They let you dynamically extend your persona description without editing it.

### What Are Add-Ons?

Each add-on is a labeled block of text with an on/off toggle:

- **Label** — A short name (e.g., "Combat Skills," "Secret Backstory," "Romantic Interest")
- **Content** — The text that gets appended to your persona description when enabled
- **Enabled** — Whether it's currently active

When an add-on is enabled, its content is appended to the `{{persona}}` macro output during prompt assembly.

### Creating Add-Ons

1. Open the persona editor
2. Click the **Add-Ons** button
3. Click **Add New** in the add-ons modal
4. Fill in the label and content
5. Toggle it on or off

### Quick Toggling

During a chat, you can quickly toggle add-ons without opening the full editor:

1. Click the **Puzzle icon** in the input area action bar
2. A dropdown shows all your add-ons with toggles
3. Flip any switch — it takes effect on the next generation

The puzzle icon only appears when your active persona has at least one add-on.

Toggles flipped from this dropdown are remembered **per chat** — opening another chat with the same persona doesn't carry the change over, so you can have one chat where "Injured" is on and another where it's off.

---

## Global Add-Ons

If you find yourself reusing the same add-on across multiple personas (e.g. a "GM Notes" block, or a recurring NPC companion), create it once as a **global add-on** and attach it to any persona that needs it.

### Creating Global Add-Ons

1. Open the **Persona** panel and click the **Global Add-Ons Library** button (also reachable from the persona editor's add-ons modal)
2. Click **Add Global Add-On**
3. Give it a label and content — the library auto-saves

### Attaching to a Persona

1. Open the persona editor and click **Add-Ons**
2. Scroll to the **Global Add-Ons** section
3. Click **Attach Global Add-On** and pick from the library — each attached add-on gets its own toggle on this persona

Attached global add-ons appear alongside the persona's own add-ons in the quick-toggle puzzle dropdown. Edits to a global add-on update everywhere it's attached — there's only one source of truth.

### Example Add-Ons

| Label | Content |
|-------|---------|
| "Has a Pet" | "Alex is always accompanied by a small calico cat named Patches who sits on their shoulder." |
| "Injured" | "Alex's right arm is in a sling from a recent climbing accident. They're in mild pain and slightly clumsy." |
| "Knows the Secret" | "Alex has discovered the truth about the organization's experiments but hasn't told anyone yet." |

This lets you evolve your persona over the course of a story without constantly editing the base description.
