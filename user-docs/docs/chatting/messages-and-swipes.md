---
title: Messages & Swipes
---

# Messages & Swipes

Understanding how messages work — and how to get the most out of swipes — is key to having great conversations.

---

## Sending Messages

Type your message in the input area and press **Enter** to send (or click the send button). The AI starts generating a response immediately, with tokens appearing in real time.

!!! tip "Shift+Enter"
    Press **Shift+Enter** to add a new line without sending.

### Formatting bar

Enable **Settings → Chat → Input → Formatting bar** to show a compact floating pill above the composer. It is off by default, and your choice is saved with your account.

Tap **B**, **I**, **U**, **"**, **'**, or **( )** to insert a pair of symbols with the caret between them. If you select text first, the button wraps that text and keeps it selected so you can apply another format. Underline inserts `<u>…</u>`; bold and italic use Markdown.

The controls grow with font scaling and keep comfortable touch targets on touchscreens. Swipe the row horizontally when it does not fit in a narrow pane.

---

## Editing Messages

Click on any message to edit its text. Both your messages and the character's messages can be edited.

The editor gives user-authored messages two ways to finish:

| Action | Result |
|--------|--------|
| **Save** | Saves the revised text without asking the AI for another response. |
| **Edit and Send** | Creates and opens a new branch, preserving the original conversation. Lumiverse applies the edit there and immediately asks the AI to respond again. If an assistant reply already follows that turn, the branch receives a new swipe on its copy of that reply; at the end of a chat, it receives the next assistant message. |

**Edit and Send** is unavailable while another response is streaming. You can hide this optional action under **Settings → Productivity → Optional surfaces & navigation**.

Editing a character's message also updates the current swipe — so the content stays consistent.

---

## Deleting Messages

Hover over a message and click the **delete** button to remove it. Deleted messages are gone permanently.

---

## Regenerating

Don't like the AI's last response? Click **Regenerate** to get a new one. The previous response isn't lost — it becomes a swipe you can navigate back to.

---

## Swipes

Swipes are alternate versions of the same message. Every time you regenerate a response, the new version is added as a swipe. You can navigate between swipes using the **left/right arrows** on the message.

Think of swipes as a deck of cards — each one is a different take on the same conversational moment. You can:

- **Swipe left/right** to browse alternatives
- **Regenerate** to add a new swipe to the deck
- **Edit** any individual swipe
- The currently displayed swipe is what the AI sees as "the message" in subsequent turns

### Variables and swipes

Lumiverse saves the starting and resulting macro variables for each newly generated swipe. Regenerating starts from the state before the original reply, so alternative replies apply their variable changes independently. Continuing a reply starts from its current state.

Switching swipes on the final reply restores that swipe's variables. Switching an older reply leaves the current variables alone until later messages are deleted or you branch the chat at that point. Later manual variable edits are preserved.

Existing replies without saved variable history cannot have their earlier state reconstructed.

### Generate while reading

On the final assistant reply, **Ctrl+click** the right swipe arrow (Windows/Linux)
or **Cmd+click** it (Mac) to generate another swipe while keeping the current
response selected. On mobile, **hold the right swipe arrow** for the same action;
its context menu is suppressed. **Ctrl/Cmd+Right Arrow** also starts a background
swipe when swipe navigation is enabled and you are not editing text. With the
arrow focused, **Ctrl/Cmd+Enter** does the same.
A pulsing dot points toward the generating swipe; it becomes steady when ready.
Click that arrow normally when you want to read the new response. This action
is unavailable while a generation is already running.

### Why Swipes Matter

Swipes are one of the most powerful features in AI chat. Instead of accepting the first response, you can:

- Generate 3-5 swipes and pick the best one
- Find the response that best matches the tone you want
- Explore different directions the story could go
- Keep the good parts of one swipe and edit in elements from another

---

## Continue

If a response feels cut short, click **Continue** to ask the AI to keep writing from where it left off. The continuation is appended to the current message rather than creating a new one.

---

## Impersonate

Impersonation generates a draft from your persona's point of view and places it in the input box for review. Choose the account-wide default under **Settings → Chat → Default impersonation mode**. A chat or group chat can inherit that choice or override it under **Chat Settings → Impersonation Mode**:

- **Preset Prompts** uses the chat's active preset and its impersonate-triggered blocks.
- **Impersonation Preset** fully assembles the dedicated preset selected in Chat Settings, including chat history and its impersonation prompt. It falls back to the active preset when none is selected.
- **One-liner** uses only chat history and the dedicated preset's impersonation prompt. It adds the preset's assistant prefill only when **Continue Prefill** is enabled.

The input-bar **Impersonate** button uses the chat override when one is set and otherwise follows the global default. The initial global default is One-liner, and the dedicated impersonation preset does not replace the chat's main preset.
For both full-preset options and One-liner, impersonation prefills are ignored unless **Continue Prefill** is enabled in the selected preset. When it is disabled, the impersonation instruction is sent as the final user message instead; when enabled, it is followed by the preset's partial assistant prefill.

---

## Stopping Generation

If the AI is generating something you don't want, click **Stop** to halt generation immediately. The partial response is saved — you can edit it, delete it, or regenerate.

---

## Dry Run

Before sending a real request, you can preview exactly what the AI will see:

1. Click the **Dry Run** button in the input area
2. Lumiverse assembles the full prompt (presets, character data, world info, macros) without calling the AI
3. A modal shows you the complete message list, token breakdown, and parameter settings

This is invaluable for debugging prompts, checking world book activation, and understanding why the AI is behaving a certain way.
