---
title: Extensions
---

# Extensions

Lumiverse supports extensions through **Spindle**, a permission-gated extension runtime. A backend extension runs in a host-selected `process` mode (separate subprocess), `sandbox` mode (platform sandboxing where available plus cooperative guards), or legacy `worker` mode (an in-process worker with cooperative guards), while its frontend bundle loads separately in the browser. The RPC bridge and extension APIs stay consistent across backend modes; the mode is controlled by Lumiverse, not by the extension.

---

## What Extensions Can Do

- Add free drawer tabs and input-bar buttons, plus permission-gated dock panels, float widgets, and app mounts
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
| `ui_panels` | Create float widgets, dock panels, and built-in-tab roots, or move supported drawer tabs; drawer tabs and input-bar actions are free |
| `tools` | Register council/agent tools and receive `TOOL_INVOCATION` events |
| `ephemeral_storage` | Use the ephemeral storage tier (quota- and TTL-managed) |
| `event_tracking` | Track, query, and replay generation events |
| `chat_mutation` | Hide / unhide messages and perform bulk mutations on the *current* chat |
| `generation_parameters` | Read the generation parameters used for the latest call |
| `memories` | Read and mutate Memory Cortex entities, relations, configuration, vaults, chat links, and long-term chat-memory data (full CRUD where the API supports it) |
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
| `app_manipulation` | Mount unrestricted app portals, move supported drawer tabs between the main drawer and registered containers, and apply theme or chat-style changes |
| `unsafe_eval` | Allow `allowEval: true` only for host-managed sandbox frames created through `ctx.dom.createSandboxFrame`; this does not enable general frontend or backend evaluation |
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
    Auto-granted permissions cover low-risk extension surfaces such as `ui_panels` screen placements, ephemeral storage, event tracking, and read/write memory APIs. Drawer tabs and input-bar actions are permissionless and do not need a manifest permission. Privileged permissions can reach sensitive user data, the network, dynamic frontend sandbox evaluation, or app-wide UI/prompt behavior — Lumiverse keeps them off by default so a misbehaving or compromised extension can't silently exfiltrate or rewrite content.

---

## Manifest Capabilities

Separate from runtime permissions, an extension's manifest can declare **capabilities** that bypass specific install/update code-pattern scans. The `dynamic_code_execution` capability also enables guarded dynamic-code constructors in backend runtimes and extension-owned backend-process children; it does not enable frontend evaluation.

| Capability | Meaning |
|------------|---------|
| `dynamic_code_execution` | Author is intentionally using guarded `eval` / Function-family constructors in backend/runtime-process code (for example, a sandboxed expression evaluator). It does not grant module loading, frontend evaluation, or host system APIs; recognized loader forms in scanned source and runtime guards remain blocked, while native generated `import()` is not intercepted |
| `base64_decode` | Author is intentionally using base64-decoded payloads (e.g. embedded assets) |

Capabilities do not grant access to Lumiverse data or host APIs. They tell the installer which declared scanner exception is intentional; `dynamic_code_execution` controls guarded constructors only in backend/runtime-process code. The declaration is evaluated during install/update and loaded when the backend starts; changing it requires a reload/restart. Unresolved or dynamic **bare** `import(specifier)` / `require(specifier)` expressions visible in scanned backend source fail closed. Without the declaration, the installer rejects the pattern and the backend runtime keeps dynamic code disabled.

---

## UI Extension Points

Extensions can mount UI in several surfaces. Each surface has both per-extension caps and global caps so a single extension can't crowd the workspace.

| Surface | Per Extension | Global | Notes |
|---------|:---:|:---:|-------|
| **Drawer tabs** | 4 | 8 | Free; full panels in the drawer, with title, short name, icon, badge, keywords |
| **Dock panels** | 1 per edge | 2 per edge | Requires `ui_panels`; edges: top, bottom, left, right |
| **Float widgets** | 2 | 8 | Requires `ui_panels`; free-floating panels; can be fullscreen, snap to edges, or chromeless |
| **Input-bar actions** | 4 | 12 | Free; buttons next to the chat input action bar |
| **App mounts** | 1 | 4 | Requires `app_manipulation`; full-page or overlay mounts; positions: start, end, app-overlay |
| **Command palette entries** | unlimited | — | Free; scoped to global / chat / chat-idle / landing / character |
| **Modals** | up to 2 stacked | — | Free; `open`, `confirm`, `textInput`, or custom content |

Tab mobility is method-specific: `requestTabLocation` accepts either `app_manipulation` or `ui_panels`, `getBuiltInTabRoot` requires `ui_panels`, and the read-only `getTabLocation` query is free. An extension can move supported built-in tabs or its own tabs, but not another extension's tabs.

Extensions can also mount native Lumiverse form components (text inputs, selects, combos, sliders, date/time pickers, color pickers) inside their own panels via the Components API, so they don't have to reimplement the design system from scratch.

---

## For Developers

If you want to build your own extensions, see the [Spindle developer docs](https://docs.lumiverse.chat){:target="_blank"} for the full API reference, including the manifest schema, RPC bridge, storage tiers, generation APIs, and example extensions.
