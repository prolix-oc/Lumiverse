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
| [OOC Comments](ooc.md) | Out-of-character asides and meta-commentary |
| [Loom Summary](loom-summary.md) | Automatic and manual story summarization |
| [Long-Term Memory](memory.md) | Recall relevant past moments via vector search |
| [Guided Generation](guided-generation.md) | Reusable prompt fragments that shape responses |
| [Quick Replies](quick-replies.md) | Pre-written message templates for fast input |
| [Regen Feedback](regen-feedback.md) | Guide regenerations with specific feedback |

---

## How a Chat Works

When you send a message, here's what happens behind the scenes:

1. Your message is saved to the chat
2. Lumiverse assembles the full **prompt** — your preset blocks, character data, persona, world book entries, chat history, and any active macros
3. The assembled prompt is sent to your AI provider via the active **connection**
4. Tokens stream back in real time, appearing word-by-word in the chat
5. When generation finishes, the complete response is saved as a message

The entire prompt assembly process is configurable through [Presets](../presets/index.md), and you can preview exactly what the AI sees using the **Dry Run** feature.

---

## Chat Management

From the **Landing Page** or the **Manage Chats** modal, you can:

- **View recent chats** — Grouped by character with last message previews
- **Delete chats** — Remove conversations you no longer need
- **Export chats** — Save the full conversation as JSON data
