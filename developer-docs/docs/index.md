# Spindle Extension Developer Guide

Build extensions for Lumiverse using Spindle — an isolated extension system with backend workers, safe DOM injection, and a tiered permission model.

---

## What is Spindle?

Spindle is Lumiverse's extension framework. It lets you add custom functionality to Lumiverse through isolated modules that run in backend workers and/or in the browser.

**Backend modules** run in isolated Bun worker threads with access to the `spindle` global API — events, storage, LLM generation, macros, and more.

**Frontend modules** run in the browser with a sandboxed context for DOM injection, event handling, and backend communication. All HTML is sanitized through DOMPurify.

## Key Features

- **Event-driven** — subscribe to any Lumiverse lifecycle event
- **Custom macros** — register `{{macros}}` for use in prompts and preset blocks
- **LLM generation** — fire raw, quiet, or batch generations programmatically
- **Prompt interceptors** — modify the assembled prompt before it reaches the LLM
- **Scoped storage** — private file storage per extension, per user, or ephemeral with TTL
- **Secure enclave** — AES-256-GCM encrypted secret storage for API keys and tokens
- **Safe DOM injection** — inject sanitized HTML and CSS via the frontend DOM helper
- **UI placements** — drawer tabs, floating widgets, dock panels, input bar actions
- **CORS proxy** — make HTTP requests through the server, bypassing browser restrictions
- **OAuth support** — full OAuth PKCE flow with callback handler registration

## Quick Links

- [Quick Start](getting-started/quick-start.md) — get your first extension running
- [Manifest Reference](getting-started/manifest.md) — configure `spindle.json`
- [Permissions](getting-started/permissions.md) — understand the permission model
- [Backend API](backend-api/index.md) — the `spindle` global reference
- [Frontend API](frontend-api/index.md) — the `ctx` context reference
- [Examples](examples/index.md) — complete working extensions
- [REST API](rest-api.md) — manage extensions via HTTP
