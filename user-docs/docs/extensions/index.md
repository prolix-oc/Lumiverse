---
title: Extensions
---

# Extensions

Lumiverse supports extensions through **Spindle**, an isolated extension runtime. Extensions can add new features, modify behavior, and integrate with external services — all sandboxed inside a Bun Worker with a permission-gated RPC bridge to the rest of the app.

---

## What Extensions Can Do

- Add custom panels, dock widgets, float widgets, and input-bar buttons
- Define new macros for use in presets
- Intercept and modify prompts, raw templates, or world-info injections before generation
- Listen to events (messages, generation lifecycle, tool invocations, generation parameters)
- Read and write persistent and ephemeral storage (with per-extension quotas)
- Access the LLM generation pipeline (raw, batch, streaming, dry-run, observe)
- Register **council tools** that show up in the Lumia Council
- Register **command palette** entries scoped to global, chat, character, or landing contexts
- Open **modal dialogs** (confirm, text input, custom) using Lumiverse's shared component library
- Apply theme overrides and asset bundles
- Send push notifications
- Read the user's configured web-search provider (read-only)
- CRUD over characters, chats, personas, presets, world books, regex scripts, databanks, and memories — each gated by its own permission

---

## Installing Extensions

!!! warning "Trust model"
    Extensions run real code on your server. Only install extensions from sources you trust — installing one is equivalent to running arbitrary code on your machine. Privileged permissions (see below) require explicit admin approval before they take effect.

1. Open the **Spindle Panel** (drawer → **Extensions**)
2. Click **Add Extension** in the panel header
3. In the dropdown:
    * Paste a **GitHub repo URL** into *Install from Source*. If the repo has multiple branches, a **Branch** selector appears so you can target staging/dev branches as well as the default.
    * **Owner / admin only:** *Import Local* loads any extensions you've placed under `data/extensions/` on the server filesystem — useful for development or for shipping bundled extensions with a Docker image.
4. Review the requested permissions and click **Install**

Newly installed extensions are **disabled by default**. After install, flip the **Enable** toggle and grant any privileged permissions you want to honor.

### Updating Extensions

Each installed extension card has its own **Update** button that re-fetches and rebuilds from its source. The panel header also has an **Update All** action that walks through every git-sourced extension sequentially — disabled extensions are still updated but remain disabled afterward.

### Install Scope

Extensions can be installed at two scopes:

| Scope | Who Installs | Visibility |
|-------|--------------|------------|
| **Operator** | Owner / admin accounts | Available to every user on the instance |
| **User** | Any user | Only visible to the user who installed it |

The scope is decided at install time based on who's installing.

---

## Managing Extensions

From the Spindle Panel:

- **Enable / Disable** — Toggle extensions on and off without uninstalling
- **Configure** — Open extension-specific settings (if the extension registers any)
- **Permissions** — Per-permission toggles for everything the extension requested
- **Update** — Pull the latest source and rebuild
- **Uninstall** — Remove the extension, its storage, and its grants

---

## Permissions

Every extension declares the permissions it needs in its manifest. Lumiverse splits them into two tiers:

### Auto-Granted (non-privileged)

These are granted automatically at install time. They're the building blocks for benign extensions that only add UI or react to events.

| Permission | What It Grants |
|------------|----------------|
| `ui_panels` | Mount drawer tabs, dock panels, float widgets, input-bar actions, app mounts |
| `tools` | Register council/agent tools and receive `TOOL_INVOCATION` events |
| `ephemeral_storage` | Use the ephemeral storage tier (quota- and TTL-managed) |
| `event_tracking` | Track, query, and replay generation events |
| `chat_mutation` | Hide / unhide messages and perform bulk mutations on the *current* chat |
| `generation_parameters` | Read the generation parameters used for the latest call |
| `memories` | Read memory cortex entities, relationships, and chunks |
| `oauth` | Run an OAuth flow on behalf of the user (provider-scoped) |

### Privileged (admin approval required)

These can read sensitive data, modify pipeline behavior, or reach outside the sandbox. They are listed on install but only take effect after an admin explicitly toggles them on.

| Permission | What It Grants |
|------------|----------------|
| `generation` | Run the generation pipeline directly (raw / quiet / batch / stream) |
| `interceptor` | Modify the assembled prompt and inject parameters before the LLM call |
| `macro_interceptor` | Transform raw macro templates before parsing |
| `context_handler` | Contribute additional context blocks during prompt assembly |
| `cors_proxy` | Make HTTP requests through the server (bypassing browser CORS) |
| `app_manipulation` | Apply theme variable overrides and other app-wide UI changes |
| `push_notification` | Send push notifications to the user |
| `image_gen` | Drive the image-generation pipeline |
| `images` | Read and write the user's stored images |
| `web_search` | Read the user's configured web-search provider |
| `characters` | Read and write character cards |
| `chats` | Read and write chats and chat metadata |
| `presets` | Read and write prompt presets |
| `world_books` | Read and write world books |
| `regex_scripts` | Read and write regex scripts |
| `databanks` | Read and write databank documents |
| `personas` | Read and write user personas |

!!! tip "Why two tiers?"
    Auto-granted permissions cover surface area an extension needs just to *exist* (UI mounts, ephemeral storage, event tracking). Privileged permissions touch user data, the network, or the prompt pipeline — Lumiverse keeps them off by default so a misbehaving or compromised extension can't silently exfiltrate or rewrite content.

---

## Manifest Capabilities

Separate from runtime permissions, an extension's manifest can declare **capabilities** that bypass install-time code-pattern scans:

| Capability | Meaning |
|------------|---------|
| `dynamic_code_execution` | Author is intentionally using `eval` / the `Function` constructor (e.g. for safe expression evaluators) |
| `base64_decode` | Author is intentionally using base64-decoded payloads (e.g. embedded assets) |

These do not grant any runtime privilege — they just tell the installer's scanner "yes, I really mean this." Without the declaration, the installer flags the pattern and refuses to install.

---

## UI Extension Points

Extensions can mount UI in several surfaces. Each surface has both per-extension caps and global caps so a single extension can't crowd the workspace.

| Surface | Per Extension | Global | Notes |
|---------|:---:|:---:|-------|
| **Drawer tabs** | 4 | 8 | Full panels in the drawer, with title, short name, icon, badge, keywords |
| **Dock panels** | 1 per edge | 2 per edge | Edges: top, bottom, left, right |
| **Float widgets** | 2 | 8 | Free-floating panels; can be fullscreen, snap to edges, or chromeless |
| **Input-bar actions** | 4 | 12 | Buttons next to the chat input action bar |
| **App mounts** | 1 | 4 | Full-page or overlay mounts; positions: start, end, app-overlay |
| **Command palette entries** | unlimited | — | Scopable: global / chat / chat-idle / landing / character |
| **Modals** | up to 2 stacked | — | `open`, `confirm`, `textInput`, or custom content |

Extensions can also mount native Lumiverse form components (text inputs, selects, combos, sliders, date/time pickers, color pickers) inside their own panels via the Components API, so they don't have to reimplement the design system from scratch.

---

## For Developers

If you want to build your own extensions, see the [Spindle developer docs](https://docs.lumiverse.chat){:target="_blank"} for the full API reference, including the manifest schema, RPC bridge, storage tiers, generation APIs, and example extensions.
