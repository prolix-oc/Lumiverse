# Interface Overview

Lumiverse's interface is built around a central chat view with a tabbed drawer that pulls in from the edge of the screen. Here's a tour of what's where.

---

## Main Layout

```
+--------------------------------------+----+
|                                      |    |
|         Chat Area                    | T  |
|                                      | a  |
|                                      | b  |
|                                      | s  |
+--------------------------------------+    |
|         Input Area                   |    |
+--------------------------------------+----+
```

- **Chat Area** — Where messages appear. Shows the conversation with your character, including avatars, expressions, and (optionally) a per-chat wallpaper background.
- **Input Area** — Where you type messages. Includes action buttons for attachments, persona switching, quick replies, add-on toggles, and dry runs.
- **Drawer** — A single docked drawer that hosts every panel as a tab. Pinned tabs appear on the visible edge so you can switch with one click; the rest live behind an overflow menu.
- **Chat Heads (optional)** — Floating circular avatars that follow the screen edge and act as quick-switchers between recent chats.

Drawer panels can be docked to the opposite edge using the [Spindle](../extensions/index.md) **dockPanels** system, and on mobile the drawer slides in as a sheet.

---

## Drawer Tabs

The drawer hosts every workspace panel as a tab. You can reorder them with drag-and-drop and hide ones you don't use from the tab-bar context menu.

### Character & Story

| Tab | Purpose |
|-----|---------|
| **Profile** | View and edit the active character's card |
| **Characters** | Browse, search, import, and manage your character library |
| **Personas** | Create, switch, and manage user [personas](../personas/index.md) |
| **Lorebook** | Edit [world books](../world-books/index.md) and lorebook entries |
| **Pack Browser** | Browse and install [content packs](../packs/index.md) (Lumias, Looms, themes, tools) |
| **Creator Workshop** | Author your own Lumia items and Loom presets |

### Generation Configuration

| Tab | Purpose |
|-----|---------|
| **Reasoning** | Configure chain-of-thought, reasoning effort, prompt prefix/suffix, and start-reply-with |
| **Loom** | Configure narrative structure, story beats, pacing, Sovereign Hand, and director cues |
| **Composition** | Pick which Lumia/Loom content is active, set context filters, and tune prompt assembly |
| **Connections** | Manage LLM, Image, Speech-to-Text, and Text-to-Speech API connections |
| **Council** | Configure the Lumia Council, tool functions, and sidecar agents |
| **Summary** | Configure context summarization and truncation |

### Memory & Knowledge

| Tab | Purpose |
|-----|---------|
| **Memory Cortex** | Browse entities, relationships, font colors, and stats. Manage [vaults and interlinks](../chatting/memory-cortex.md#vaults-interlinks) here. |
| **Databank** | Upload reference documents that the AI can pull from during generation |
| **World Info** | Live readout of which lorebook entries activated for the current generation |
| **Council Feedback** | Inspect the latest council execution — what the tools did and why |

### Visual & Output

| Tab | Purpose |
|-----|---------|
| **Image Generation** | Configure and trigger AI image / scene generation |
| **Wallpaper** | Set global or per-chat backgrounds (images, video, animated GIFs) |
| **Theme** | Customize colors, accents, fonts, glass effects, and CSS overrides |
| **Regex Scripts** | Author find/replace transformations for prompts or rendered output |

### Meta

| Tab | Purpose |
|-----|---------|
| **OOC** | Out-of-character comment display settings |
| **Branch Tree** | Visualize and navigate the chat's branch history |
| **Weaver** | Author characters and worlds from your idea through a guided interview |
| **Extensions** | Install and manage [Spindle](../extensions/index.md) extensions |

Spindle extensions can register additional drawer tabs that appear alongside the built-ins.

---

## Chat Controls

Inside an active chat, each message exposes:

- **Regenerate** — Re-roll the last AI response (creates a new swipe)
- **Continue** — Ask the AI to continue writing from where it left off
- **Swipe arrows** — Navigate between alternative responses on the same message
- **Edit** — Click on any message to edit its content in place
- **Branch** — Fork the conversation at any message into a separate timeline
- **Author's Note** — Inject a system-level instruction at a configurable depth

---

## Input Area Actions

The input area exposes several actions beyond just sending messages:

- **Attachments** — Upload images, audio, or documents to include with your message
- **Persona switcher** — Quickly change which [persona](../personas/index.md) is active for this chat
- **Quick Replies** — Insert pre-written response templates
- **Guided Generation** — Enable structured output guidance
- **Add-ons (Puzzle icon)** — Toggle [persona add-on](../personas/bindings-and-addons.md#persona-add-ons) blocks on and off, including global add-ons attached to the active persona
- **Dry Run** — Preview the exact prompt the AI will see without sending a real request
- **Voice input** — Dictate via the configured Speech-to-Text connection

Per-chat toggle state for add-ons is remembered, so flipping a block off in one chat doesn't affect another.

---

## Command Palette

Press **Cmd+K** (macOS) or **Ctrl+K** (Windows / Linux) to open the Command Palette. This is the fastest way to navigate Lumiverse and gives quick access to:

- Drawer tabs and modal panels
- Settings sections
- Chat-specific actions (regenerate, swipe, branch, etc.)
- Extension-registered commands

Type to search, then press Enter to execute.

---

## Landing Page

When you open Lumiverse (or navigate to the home page), you land on the **Landing Page**. It shows recent chats grouped by character. Click any chat to resume it, or click a character to start a new conversation. The landing page layout (compact list vs. grid) and the number of chats shown are configurable from **Settings → Display**.

---

## Settings

Click the gear icon (or open the Command Palette and search "Settings") to open the **Settings** modal. The sidebar groups settings into categories:

### Account & Display
| Section | What's Inside |
|---------|---------------|
| **Account** | Username, password, avatar |
| **Display** | Modal sizing, pagination, toast positions, landing layout, chat heads |
| **Chat** | Message-per-page, enter-to-send, draft saving, message render options |
| **Notifications** | Push notification preferences |

### AI & Generation
| Section | What's Inside |
|---------|---------------|
| **Embeddings** | [Vector embedding](../settings/embeddings.md) provider and indexing config |
| **Memory Cortex** | Entity tracking, salience, sidecar, [memory cortex](../chatting/memory-cortex.md) config |
| **Web Search** | SearXNG integration for the web-search tool |
| **Tokenizers** | Manage tokenizer downloads for accurate token counting |
| **Voice** | Speech-to-Text and Text-to-Speech defaults |
| **MCP Servers** | Manage Model Context Protocol server connections |
| **Guided Generation** | Default templates for guided output |
| **Quick Replies** | Manage the input-area quick-reply library |

### Extensions
| Section | What's Inside |
|---------|---------------|
| **Extensions** | Manage installed Spindle extensions |
| **Extension Pools** | Per-extension storage quota overrides |

### Operations
| Section | What's Inside |
|---------|---------------|
| **LumiHub** | LumiHub account and content sharing |
| **Users** | (Multi-user installs) Manage additional user accounts |
| **Data Portability** | Export / import everything, API keys, tickets |
| **Migration** | Import from SillyTavern (Local, SFTP, SMB, Google Drive, Dropbox); re-apply TagLibrary backups |
| **Operator Panel** | Check for updates, switch branches, restart server (requires the runner) |
| **Advanced** | Power-user toggles |
| **Diagnostics** | System health, version, embedding/cortex status |

!!! tip "Mobile"
    On smaller screens, the drawer becomes a slide-in sheet. Swipe from the edge, tap any pinned tab icon, or use the Command Palette to navigate. Lumiverse also supports PWA installs — add it to your home screen for an app-like experience.
