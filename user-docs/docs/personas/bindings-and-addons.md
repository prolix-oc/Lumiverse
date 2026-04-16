# Bindings & Add-Ons

Beyond basic persona setup, Lumiverse offers two power features: **character bindings** that auto-activate personas, and **add-ons** that let you toggle extra persona content on and off.

---

## Character-Persona Bindings

You can bind a persona to a specific character so that persona automatically activates whenever you open a chat with that character.

### Setting Up a Binding

1. Open the **Persona** panel
2. Select the persona you want to bind
3. Click **Bind to Character**
4. Choose the character from the list

Now, whenever you open a chat with that character, your persona switches automatically.

### How Bindings Work

- Bindings are stored as a setting (`characterPersonaBindings`) — a mapping of character IDs to persona IDs
- When you open a chat, Lumiverse checks if the character has a binding and switches your active persona
- If you manually switch personas in a chat, that overrides the binding for that session
- Deleting a persona automatically cleans up its bindings

### Use Cases

- Bind your "Fantasy Knight" persona to fantasy characters
- Bind your "Modern Self" persona to slice-of-life characters
- Bind a specific persona to a character that expects a particular partner

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

### Example Add-Ons

| Label | Content |
|-------|---------|
| "Has a Pet" | "Alex is always accompanied by a small calico cat named Patches who sits on their shoulder." |
| "Injured" | "Alex's right arm is in a sling from a recent climbing accident. They're in mild pain and slightly clumsy." |
| "Knows the Secret" | "Alex has discovered the truth about the organization's experiments but hasn't told anyone yet." |

This lets you evolve your persona over the course of a story without constantly editing the base description.
