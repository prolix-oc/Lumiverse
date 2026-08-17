# Directory & File Structure

**Analysis Date:** 2026-08-17

## High-Level Repository Layout

```
Lumiverse/
├── .planning/               # Architecture, planning, and codebase documentation
│   └── codebase/            # Codebase analysis maps and architecture guides
├── conductor/               # Product guidelines, track specifications, and workflow docs
├── data/                    # Local runtime storage (SQLite DB, vectors, cache, assets)
├── desktop/                 # Experimental Tauri v2 desktop shell (Rust + WebView)
│   ├── src/                 # Desktop frontend shell / helper pages
│   └── src-tauri/           # Rust Tauri host, runner supervisor, and tray handlers
├── developer-docs/          # Technical specifications and extension authoring manuals
├── frontend/                # React 19 + Vite web client SPA & PWA
│   ├── public/              # Static public assets, favicons, audio cues
│   ├── scripts/             # Build scripts (CSS extraction, prop analyzers)
│   └── src/                 # Client source code (components, stores, api, hooks)
├── rules/                   # Cursor and IDE development rules
├── scripts/                 # Maintenance, migration, benchmark, and runner tools
│   └── runner/              # Headless/terminal server process runner
├── spindle-extensions/      # First-party Spindle extension packages
│   └── lumiverse_suite/     # Core unified UI & productivity extension suite
├── src/                     # Backend core server application (Bun + Hono)
│   ├── auth/                # Better-Auth integration and user seeding
│   ├── crypto/              # Encryption, VAPID keys, and token signing
│   ├── db/                  # SQLite connection, pragmas, and schema migrations
│   ├── file-connections/    # Cloud storage integrations (Google Drive, Dropbox)
│   ├── image-gen/           # Image generation providers (ComfyUI, NovelAI, etc.)
│   ├── llm/                 # Unified LLM provider adapters and stream utilities
│   ├── lumihub/             # LumiHub cloud link, synchronization, and installer
│   ├── macros/              # AST parser, lexer, and evaluators for prompt macros
│   ├── middleware/          # Security, compression, and rate-limiting middleware
│   ├── migration/           # SillyTavern and external format migration scripts
│   ├── multiplayer/         # Multiplayer room tokens, relay clients, and attestation
│   ├── routes/              # Hono REST API sub-routers (/api/v1/*)
│   ├── services/            # Domain services, prompt assembly, memory cortex, weaver
│   ├── spindle/             # Extension lifecycle, sandbox host, and provider broker
│   ├── tts/                 # Text-to-Speech provider registries and streaming
│   ├── types/               # Internal backend TypeScript type declarations
│   ├── utils/               # Sanitizers, regex sandbox, color engine, HTTP helpers
│   └── ws/                  # Real-time WebSocket gateway and topic EventBus
├── stream-deck/             # Elgato Stream Deck hardware integration plugin
├── tests/                   # Integration, concurrency, and end-to-end test suites
├── user-docs/               # End-user documentation and manual pages
├── package.json             # Backend dependencies and project runner scripts
├── start.sh                 # Linux/macOS bootstrap and update shell script
└── start.ps1                # Windows PowerShell bootstrap and update script
```

---

## Detailed Directory Breakdown

### 1. Backend Core (`src/`)

| Directory | Responsibility & Purpose |
| :--- | :--- |
| [`src/auth/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/auth) | Better-Auth integration, password hashing, owner initialization ([`seed.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/auth/seed.ts)), authentication middleware ([`middleware.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/auth/middleware.ts)), and default preset provisioning. |
| [`src/crypto/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/crypto) | Cryptographic identity generation ([`identity.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/crypto/identity.ts)), AES secret encryption ([`credentials.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/crypto/credentials.ts)), VAPID key pairs for Web Push ([`vapid.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/crypto/vapid.ts)), and HMAC room token minting. |
| [`src/db/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db) | SQLite database lifecycle ([`connection.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/connection.ts)), automated maintenance schedulers ([`maintenance.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/maintenance.ts)), migration runner ([`migrate.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/migrate.ts)), and 100+ SQL migration scripts ([`migrations/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/migrations)). |
| [`src/file-connections/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/file-connections) | External storage cloud providers and sync drivers (Google Drive, Dropbox). |
| [`src/image-gen/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/image-gen) | Image generation provider implementations, parameter schemas, ComfyUI workflow parsers, and node discovery. |
| [`src/llm/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm) | Built-in LLM providers ([`providers/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/providers)), provider registry ([`registry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/registry.ts)), SSE stream chunking utilities ([`stream-utils.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/stream-utils.ts)), and common schema types. |
| [`src/lumihub/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/lumihub) | LumiHub client WebSocket connection, package installation and payload verification, sealed presets, and telemetry. |
| [`src/macros/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/macros) | Custom macro lexer ([`MacroLexer.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/macros/MacroLexer.ts)), recursive descent parser ([`MacroParser.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/macros/MacroParser.ts)), AST evaluator ([`MacroEvaluator.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/macros/MacroEvaluator.ts)), and global registry ([`MacroRegistry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/macros/MacroRegistry.ts)). |
| [`src/middleware/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/middleware) | HTTP middleware: Brotli/Gzip response compression ([`compress.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/middleware/compress.ts)), sliding-window rate limiting ([`rate-limit.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/middleware/rate-limit.ts)), and upload body size exemptions. |
| [`src/migration/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/migration) | SillyTavern data migration importer, character card v2/v3 parsers, and Docker environment import automation. |
| [`src/multiplayer/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/multiplayer) | Remote identity server client, room cryptographic attestations ([`attestation.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/multiplayer/attestation.ts)), and cross-server relay clients ([`relay-client.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/multiplayer/relay-client.ts)). |
| [`src/routes/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/routes) | 40+ Hono REST routing modules mounted under `/api/v1/*` (chats, characters, world-books, connections, presets, etc.). |
| [`src/services/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services) | Core domain business logic (Prompt assembly, Generation pool, Memory Cortex, Dream Weaver, Databank, Image Gen, TTS, STT, Vector store). |
| [`src/spindle/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle) | Spindle extension runtime: worker host sandbox ([`worker-host.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle/worker-host.ts)), provider registry broker ([`provider-registry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle/provider-registry.ts)), lifecycle manager, and tool pools. |
| [`src/tts/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/tts) | Text-to-Speech provider registries and streaming adapters (Cartesia, ElevenLabs, Kokoro, OpenAI, Qwen). |
| [`src/utils/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/utils) | System utilities: SSRF-safe fetch ([`safe-fetch.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/utils/safe-fetch.ts)), isolated Regex Sandbox ([`regex-sandbox.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/utils/regex-sandbox.ts)), color analysis, and format healing. |
| [`src/ws/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws) | Bun WebSocket connection handler ([`handler.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws/handler.ts)), single-use ticket auth ([`tickets.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws/tickets.ts)), and central pub/sub broker ([`bus.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws/bus.ts)). |

---

### 2. Frontend Core (`frontend/src/`)

| Directory | Responsibility & Purpose |
| :--- | :--- |
| [`frontend/src/api/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/api) | Type-safe HTTP client abstraction ([`client.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/api/client.ts)) with automated abort signals, timeout wrapping, and domain API SDK modules. |
| [`frontend/src/components/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/components) | React 19 UI component library structured by domain (chat, panels, modals, settings, shared, spindle, landing, auth). |
| [`frontend/src/hooks/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/hooks) | Reusable React hooks for theme application, TTS playback, document titles, badging, keyboard handling, and summarization. |
| [`frontend/src/i18n/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/i18n) | Internationalization configuration, language detection, and JSON translation resource files. |
| [`frontend/src/lib/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/lib) | Frontend utilities: mobile viewport keyboard inset calculation, service worker updates, desktop floating widget catalog, navigation guards. |
| [`frontend/src/store/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/store) | Zustand global state store composed of 40+ domain slices ([`slices/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/store/slices)) and user-scoped resetters. |
| [`frontend/src/theme/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/theme) | CSS custom property stylesheets (`variables.css`, `reset.css`, `global.css`) defining the design token hierarchy. |
| [`frontend/src/ws/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/ws) | Client WebSocket manager ([`client.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/ws/client.ts)), event synchronization hook ([`useWebSocket.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/ws/useWebSocket.ts)), and background heartbeat worker. |

---

### 3. Desktop Shell (`desktop/`)

| Directory | Responsibility & Purpose |
| :--- | :--- |
| `desktop/src/` | Helper web pages (e.g. `widget.html`, `custom-url.html`) and TypeScript entry points for native WebView windows. |
| `desktop/src-tauri/src/` | Rust Tauri v2 core: runner supervisor ([`runner.rs`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/desktop/src-tauri/src/runner.rs)), WebView appearance / floating widget manager ([`frontend.rs`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/desktop/src-tauri/src/frontend.rs)), tray menus, and app lifecycle ([`lib.rs`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/desktop/src-tauri/src/lib.rs)). |
| `desktop/src-tauri/capabilities/` | Tauri v2 permission capability definitions for dialogs, window controls, and autostart. |

---

### 4. Extension Ecosystem

| Directory | Responsibility & Purpose |
| :--- | :--- |
| [`spindle-extensions/lumiverse_suite/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/spindle-extensions/lumiverse_suite) | First-party Spindle suite extension containing authoring tools, Spotify integration, prompt tools, and UI panels. |
| `lumiverse-spindle-types/` | Standalone npm package defining all shared TypeScript interfaces, DTOs, RPC envelopes, and UI component helper types. |

---

## Key File Locations Map

| Functional Domain | Key Implementation Files |
| :--- | :--- |
| **Server Startup & Boot** | [`src/index.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/index.ts) $\rightarrow$ [`src/main.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/main.ts) $\rightarrow$ [`src/app.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/app.ts) |
| **Environment Configuration** | [`src/env.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/env.ts) |
| **Database Connection & WAL** | [`src/db/connection.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/connection.ts), [`src/db/maintenance.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/maintenance.ts) |
| **Prompt Assembly Pipeline** | [`src/services/prompt-assembly.service.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/prompt-assembly.service.ts) |
| **LLM Generation Execution** | [`src/services/generate.service.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/generate.service.ts), [`src/llm/registry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/registry.ts) |
| **Memory Cortex Graph & Vector** | [`src/services/memory-cortex/index.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/memory-cortex/index.ts), [`src/services/memory-cortex/entity-graph.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/memory-cortex/entity-graph.ts) |
| **Vector Database Engines** | [`src/services/vector-store/index.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/vector-store/index.ts), [`src/services/embeddings.service.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/services/embeddings.service.ts) |
| **Spindle Extension Host** | [`src/spindle/worker-host.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle/worker-host.ts), [`src/spindle/lifecycle.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle/lifecycle.ts) |
| **Dynamic Provider Registry** | [`src/spindle/provider-registry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/spindle/provider-registry.ts) |
| **Real-time Event Broker** | [`src/ws/bus.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws/bus.ts), [`src/ws/handler.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/ws/handler.ts) |
| **Client Entry & Mounting** | [`frontend/src/main.tsx`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/main.tsx), [`frontend/src/router.tsx`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/router.tsx), [`frontend/src/App.tsx`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/App.tsx) |
| **Client State Management** | [`frontend/src/store/index.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/store/index.ts), [`frontend/src/store/user-scoped-reset.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/store/user-scoped-reset.ts) |
| **Desktop Runner Bridge** | [`scripts/runner.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/scripts/runner.ts), [`desktop/src-tauri/src/runner.rs`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/desktop/src-tauri/src/runner.rs) |

---

## Naming Conventions & Code Style Guidelines

### 1. File & Directory Naming
- **Backend Services**: `[domain].service.ts` (e.g. `characters.service.ts`, `prompt-assembly.service.ts`).
- **REST Route Modules**: `[domain].routes.ts` (e.g. `chats.routes.ts`, `world-books.routes.ts`).
- **Unit & Integration Tests**: `[target].test.ts` or `[target].test.tsx` (co-located next to the target file).
- **Frontend Components**: PascalCase for React components (`ChatView.tsx`, `MessageContent.tsx`).
- **CSS Modules**: Co-located with matching component name (`ChatView.module.css`, `MessageContent.module.css`).
- **Zustand Slices**: Kebab-case representing state domain (`chat.ts`, `spindle-placement.ts`, `image-gen-connections.ts`).
- **Database Migrations**: Sequentially numbered 3-digit prefix with snake_case description (`src/db/migrations/103_edit_and_send_outbox.sql`).

### 2. Code Patterns & Idioms
- **Type Safety**: Prefer explicit TypeScript interfaces and DTO definitions over untyped `any`.
- **Prepared Statement Isolation**: Use caching utilities that check `getDbGeneration()` from `src/db/connection.ts`.
- **CSS Architecture**: Exclusively use CSS custom properties (`var(--bg-primary)`, `var(--text-accent)`) defined in `frontend/src/theme/variables.css` rather than hardcoded hex colors.
- **Clickable File Links**: In documentation, format file references with markdown links using the `file://` scheme.

---

## "Where to Add New Code" Developer Playbook

### 1. Adding a New LLM Provider
1. Create a new provider file in [`src/llm/providers/[provider-name].ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/providers) implementing the `LlmProvider` interface (`src/llm/provider.ts`).
2. Export the provider class and instantiate it in [`src/llm/registry.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/llm/registry.ts) via `registerProvider()`.
3. Add any custom connection settings schemas or secret mappings in `src/services/connections.service.ts`.
4. If frontend configuration options are required, update `frontend/src/components/settings/ConnectionPicker.tsx`.

### 2. Adding a New Database Migration
1. Check the highest migration number in [`src/db/migrations/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/db/migrations).
2. Create the next file (e.g. `src/db/migrations/104_my_new_feature.sql`).
3. Add idempotent `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`, or index definitions.
4. Update baseline database schema definitions in `src/db/baseline.sql` if modifying core entities.

### 3. Adding a New API Endpoint
1. Define the service methods in `src/services/[domain].service.ts`.
2. Create or extend the Hono router in `src/routes/[domain].routes.ts`.
3. If creating a new router, mount it in [`src/app.ts`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/app.ts) using `app.route('/api/v1/[domain]', domainRoutes)`.
4. Add client SDK methods in `frontend/src/api/[domain].ts` using helper functions from `frontend/src/api/client.ts`.

### 4. Adding a New Frontend Panel or Modal
1. Create component and CSS module in `frontend/src/components/panels/` or `frontend/src/components/modals/`.
2. Register the modal in `frontend/src/components/modals/ModalContainer.tsx` or panel tab in `frontend/src/components/panels/ViewportDrawer.tsx`.
3. Add any supporting reactive state in a new or existing Zustand slice under `frontend/src/store/slices/`.

### 5. Adding a New Vector Store Engine
1. Implement the `VectorStoreProvider` interface (`src/services/vector-store/types.ts`) in `src/services/vector-store/providers/[engine-name].ts`.
2. Register the engine in `src/services/vector-store/index.ts`.
3. Support environment overrides in `src/env.ts` and operator configuration in `src/services/vector-store-config.service.ts`.

### 6. Adding a New Voice (TTS/STT) Provider
1. Add the provider adapter in [`src/tts/providers/`](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/tts/providers) or `src/services/stt.service.ts`.
2. Register the engine in `src/tts/registry.ts` or `src/services/stt-connections.service.ts`.
3. Add client configuration UI in `frontend/src/components/settings/VoiceSettings.tsx`.

---

*Structure analysis: 2026-08-17*
<!-- refreshed: 2026-08-17 -->
