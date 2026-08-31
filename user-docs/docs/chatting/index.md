---
title: Chatting
---

# Chatting

Chatting is the heart of Lumiverse. Once you have a character and a connection set up, everything revolves around the conversation.

---

## What You Can Do

| Feature | Description |
|---------|-------------|
| [Starting a Chat](starting-a-chat.md) | Create new conversations with one or more characters |
| [Messages & Swipes](messages-and-swipes.md) | Send, edit, delete, regenerate messages and explore alternate responses |
| [Group Chats](group-chats.md) | Conversations with multiple AI characters at once |
| [Branching](branching.md) | Fork a conversation at any point to explore different paths |
| [Author's Note](authors-note.md) | Inject hidden instructions into the conversation |
| [Attachments](attachments.md) | Send images and audio alongside your messages |
| [Speech-to-Text](speech-to-text.md) | Dictate messages with Web Speech or Whisper/STT connections |
| [OOC Comments](ooc.md) | Out-of-character asides and meta-commentary |
| [Loom Summary](loom-summary.md) | Automatic and manual story summarization |
| [Long-Term Memory](memory.md) | Recall relevant past moments via vector search |
| [Guided Generation](guided-generation.md) | Reusable prompt fragments that shape responses |
| [Quick Replies](quick-replies.md) | Pre-written message templates for fast input |
| [Regen Feedback](regen-feedback.md) | Guide regenerations with specific feedback |

---

## How a Chat Works

Lumiverse has two explicit turn modes:

**Response** follows the familiar message flow:

1. Your message is saved to the chat.
2. Lumiverse assembles the full **prompt** — preset blocks, character data, persona, World Book entries, chat history, and active macros.
3. The assembled prompt is sent to your AI provider through the active **connection**.
4. Response tokens stream into the chat.
5. When generation finishes, the complete Response is saved as a message.

**Agentic** creates one Turn Execution for the user turn. Its WORK stage can run
multiple ordered Work Segments across an attempt. Every segment starts with a
fresh context projected from the original objective, the current phase, accepted
workspace records, open required work, and the previous bounded handoff. A
segment's provider transcript and continuation carrier retire when that segment
ends; they are not replayed into the next one. Segment boundaries do not create
user messages or stream their internal provider tokens into the chat. Only after
WORK has completed, tools-disabled final rendering has succeeded, and the final
message has committed atomically does the chat receive its Agentic Response.

The prompt assembly process is configurable through [Presets](../presets/index.md).
Dry Run previews the ordinary assembled prompt; it does not execute Agentic WORK.

---

## Chat Management

From the **Landing Page** or the **Manage Chats** modal, you can:

- **View recent chats** — Grouped by character with last message previews
- **Delete chats** — Remove conversations you no longer need
- **Export chats** — Save the full conversation as JSON data
