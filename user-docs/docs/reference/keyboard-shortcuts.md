---
title: Keyboard Shortcuts
---

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

### Custom desktop bindings

Open **Settings → Key Bindings** in the desktop frontend. Choose a desktop action,
application command, or command registered by a Spindle extension. Record a shortcut
(or choose the keys manually), add it, and select **Save Bindings**.

**F13–F24** can be bound on their own or with modifiers, including keys sent by
macro pads. Other keys require **Control**, **Alt/Option**, or **Command/Super**.

Bindings use app-focused mode by default. Enable **Global key bindings** once
with desktop confirmation, then choose **Global** for each action you want to
trigger while Lumiverse is in the background. You can configure and change all
bindings in the frontend. Extensions can also include a binding editor directly
in their own panel or settings. No custom shortcuts are enabled by
default. Saving reports duplicate combinations and OS registration conflicts.
Remove a binding and save to free its shortcut. Bindings persist across restarts.
Disabling global key bindings changes the current account's shortcuts and shared
desktop actions to app-focused mode.

Application and extension commands require the integrated browser to remain open
and signed in, and keep their normal chat/page restrictions. They belong to the
selected instance and account; disabled extensions cannot receive triggers. The
desktop's **Show / Hide Lumiverse** action keeps the browser open while hiding it.
Global bindings work on macOS, Windows and Linux X11. Native Wayland sessions
currently support app-focused bindings only.

!!! tip "Command Palette is your friend"
    Almost everything in Lumiverse can be reached through the Command Palette. Learn to use it and you'll navigate the app much faster than clicking through menus.

!!! tip "Queue vs send"
    Queueing (**Cmd/Ctrl + Enter**) stacks your message onto the next generation instead of starting one immediately. Useful when the AI is mid-stream and you want to "buffer" your next input without interrupting.
