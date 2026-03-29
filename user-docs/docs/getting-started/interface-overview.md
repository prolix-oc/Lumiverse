# Interface Overview

Lumiverse's interface is built around a central chat view with collapsible panels on each side. Here's a tour of what's where.

---

## Main Layout

The app has four key areas:

```
+-----+----------------------------+------+
|     |                            |      |
| Left|       Chat Area            | Right|
|Panel|                            | Panel|
|     |                            |      |
|     +----------------------------+      |
|     |       Input Area           |      |
+-----+----------------------------+------+
```

- **Chat Area** — Where messages appear. Shows the conversation with your character, including their avatar and expression images.
- **Input Area** — Where you type messages. Includes action buttons for extras like attachments, quick replies, and persona switching.
- **Left Panel** — Usually houses the Character Browser and Persona panel.
- **Right Panel** — Usually houses Presets, World Books, Connections, and other configuration panels.

Panels can be collapsed, resized, and rearranged. On mobile, they slide in as drawers.

---

## Sidebar Panels

Click the icons along the edges to open panels:

| Panel | Purpose |
|-------|---------|
| **Character Browser** | Browse, search, import, and manage characters |
| **Persona Manager** | Create and switch between your personas |
| **Connection Manager** | Manage API connections to AI providers |
| **Preset / Loom Builder** | Configure prompt assembly and sampler settings |
| **World Book** | Manage lorebooks and world info entries |
| **Theme Panel** | Customize colors, fonts, and visual style |
| **Image Generation** | Configure and trigger AI image generation |
| **Content Workshop** | Manage packs (Lumias, Looms, Tools) |
| **Regex Scripts** | Set up text transformation rules |
| **Wallpaper Panel** | Set background images or videos |
| **Spindle Panel** | Manage installed extensions |

---

## Chat Controls

Inside an active chat, you'll find these controls:

- **Regenerate** — Re-roll the last AI response
- **Continue** — Ask the AI to continue writing from where it left off
- **Swipe arrows** — Navigate between alternative responses
- **Edit** — Click on any message to edit its content
- **Branch** — Fork the conversation at any message
- **Author's Note** — Inject a system-level instruction at a specific depth in the conversation

---

## Input Area Actions

The input area has several action buttons beyond just sending messages:

- **Attachments** — Upload images or audio to include with your message
- **Persona switcher** — Quickly change which persona you're using
- **Quick Replies** — Insert pre-written response templates
- **Guided Generation** — Enable structured output guidance
- **Add-ons** — Toggle persona add-on blocks
- **Dry Run** — Test what the AI will "see" without sending a real request

---

## Command Palette

Press **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) to open the Command Palette. This gives you quick access to:

- Navigation between pages
- Panel toggles
- Chat-specific actions
- Settings
- Extension features

Type to search, then press Enter to execute.

---

## Landing Page

When you first open Lumiverse (or navigate to the home page), you'll see the **Landing Page** showing your recent chats grouped by character. Click any chat to resume it, or click a character to start a new conversation.

---

## Settings

Click the gear icon (or use the Command Palette) to open **Settings**. Settings are organized into tabs:

| Tab | What's Inside |
|-----|---------------|
| **General** | Landing page behavior |
| **Display** | Modal sizing, pagination, toast positions |
| **Chat** | Message-per-page, enter-to-send, draft saving |
| **Appearance** | Theme presets, accent colors, glass effects |
| **Notifications** | Push notification preferences |
| **Embeddings** | Vector embedding configuration |
| **LumiHub** | Hub integration settings |
| **Advanced** | Power-user options |
| **Danger Zone** | Data deletion and reset options |
| **Diagnostics** | System health information |

!!! tip "Mobile"
    On smaller screens, panels become slide-in drawers. Swipe from the edge or tap the panel icons to open them. The interface supports PWA mode — add Lumiverse to your home screen for an app-like experience.
