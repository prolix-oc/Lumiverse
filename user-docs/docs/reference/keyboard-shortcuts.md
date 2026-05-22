# Keyboard Shortcuts

Quick reference for keyboard shortcuts in Lumiverse. On macOS, **Cmd** is the modifier; everywhere else it's **Ctrl**.

---

## Global

| Shortcut | Action |
|----------|--------|
| **Cmd/Ctrl + K** | Open Command Palette (press again to close) |
| **Escape** | Close the current modal, popover, or command palette |

---

## Composing & Sending

These work when the chat input is focused.

| Shortcut | Action |
|----------|--------|
| **Enter** | Send the message (when *Enter to Send* is on) |
| **Shift + Enter** | Insert a newline without sending |
| **Cmd/Ctrl + Enter** | **Queue** the message — append to the next generation instead of starting a new one |
| **Cmd/Ctrl + L** | Resolve macros in the input *in place* — preview what the AI will see before sending |
| **Cmd/Ctrl + Click on Send** | Same as Cmd/Ctrl + Enter — queues the message |

!!! tip "Enter to Send is configurable"
    If you turn off **Settings → Chat → Enter to Send**, plain Enter inserts a newline and Cmd/Ctrl + Enter is the only way to queue or send.

### `#` / `@` Autocomplete

When the autocomplete popover is open (after typing `#` for a databank document or `@` for a group character):

| Shortcut | Action |
|----------|--------|
| **Arrow Up / Down** | Navigate suggestions |
| **Enter** or **Tab** | Insert the highlighted suggestion |
| **Escape** | Dismiss the popover |

---

## Chat Navigation

These work anywhere outside an input field — hover over a message to target it.

| Shortcut | Action |
|----------|--------|
| **Arrow Left / Arrow Right** | Swipe the **last** assistant message left/right between alternates |
| **Shift + Arrow Left / Right** | Swipe the **hovered** assistant message instead |
| **Arrow Up** | Edit the last assistant message; press again to walk further back up the assistant thread |
| **Shift + Arrow Up** | Edit the last *user* message; press again to walk further back up the user thread |

!!! note "Smart guards"
    These shortcuts only fire when the chat is idle — i.e. nothing is streaming, no modal is open, no command palette is open, no text is selected, and you're not in multi-select mode. They also disable themselves while you're focused on a textarea or input. **Swipe gestures** can be turned off entirely from **Settings → Chat**.

---

## Command Palette

| Shortcut | Action |
|----------|--------|
| **Type to search** | Filter commands fuzzily |
| **Arrow Up / Down** | Navigate results |
| **Enter** | Execute selected command |
| **Escape** | Close the palette |

The Command Palette is the fastest way to navigate Lumiverse. It can:

- Open any drawer tab or modal
- Jump to any settings section
- Open the character browser, persona switcher, theme panel
- Run chat-specific actions (regenerate, swipe, branch, etc.)
- Execute commands registered by [Spindle extensions](../extensions/index.md)

---

## Tips

!!! tip "Command Palette is your friend"
    Almost everything in Lumiverse can be reached through the Command Palette. Learn to use it and you'll navigate the app much faster than clicking through menus.

!!! tip "Queue vs send"
    Queueing (**Cmd/Ctrl + Enter**) stacks your message onto the next generation instead of starting one immediately. Useful when the AI is mid-stream and you want to "buffer" your next input without interrupting.
