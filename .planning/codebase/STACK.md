# Technology Stack

**Analysis Date:** 2026-08-17

## Executive Summary

Lumiverse is a self-hostable, multi-user AI chat, roleplay, and creative workflow platform. The platform is architected as a decoupled TypeScript/JavaScript and Rust system:
- **Backend**: High-performance TypeScript running on the **Bun** runtime, powered by the **Hono** web framework, with embedded **SQLite** (`bun:sqlite`), integrated **LanceDB** / **Milvus** / **Qdrant** vector stores, and custom sandboxed extension runtimes (**Spindle**).
- **Frontend**: Single Page Application (SPA) and Progressive Web Application (PWA) built with **React 19**, **Vite 8**, **React Compiler**, **Zustand**, **React Router 7**, and **CodeMirror 6**.
- **Desktop Companion**: Cross-platform system tray and integrated shell built with **Tauri v2** and **Rust**.
- **Hardware Integration**: Elgato Stream Deck integration via **`@elgato/streamdeck`** and custom TypeScript plugin runtime.

---

## Languages & Runtimes

| Layer | Language / Runtime | Version / Target | Purpose | Key Source Locations |
|---|---|---|---|---|
| **Backend Runtime** | Bun | `^1.3.14` | Main application server, native SQLite, WebSockets, background vector workers, script runners | `src/index.ts`, `src/app.ts`, `bunfig.toml` |
| **Backend Language** | TypeScript | `5.x+` (ESNext / Bundler) | Type-safe backend application logic, API routing, LLM drivers | `src/**/*.ts`, `tsconfig.json` |
| **Frontend Runtime** | Modern Browser / PWA | ES2022+ / DOM | Client rendering, offline asset caching, service workers | `frontend/src/`, `frontend/sw.ts` |
| **Frontend Language** | TypeScript / TSX | `^6.0.2` (React JSX) | Declarative UI components, state management, client utilities | `frontend/src/**/*.tsx`, `frontend/tsconfig.json` |
| **Desktop Shell** | Rust | 2021 Edition | Native window management, system tray, platform-specific vibrancy | `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/` |
| **Desktop Web UI** | TypeScript / HTML / CSS | ES2022 | System tray dropdowns, custom URL config dialogs, widget POC | `desktop/src/`, `desktop/vite.config.ts` |
| **Hardware Plugin** | TypeScript / Node.js | Node 20 / CommonJS | Elgato Stream Deck action handler and icon generator | `stream-deck/src/`, `stream-deck/package.json` |
| **Dev Environment** | Nix | Nix Flakes | Reproducible development shell with C toolchain and native libs | `flake.nix` |
| **Automation & Scripts**| PowerShell & POSIX Shell | Bash / PS 5.1+ | Interactive CLI starter, dependency installer, migration scripts | `start.ps1`, `start.sh`, `scripts/` |

---

## Workspace & Subproject Structure

The repository is organized into focused subprojects and modules:

```
Lumiverse/
├── src/                         # Core Backend server source (Hono, Bun, SQLite)
│   ├── auth/                    # Better-Auth integration and user provisioning
│   ├── crypto/                  # Identity keys, VAPID, room tokens, password hashing
│   ├── db/                      # SQLite connection, maintenance pragmas, migrations 001-103
│   ├── file-connections/        # Remote filesystem adapters (Local, SFTP, SMB, GDrive, Dropbox)
│   ├── image-gen/               # Image generation providers (ComfyUI, SwarmUI, SD, NovelAI, etc.)
│   ├── llm/                     # LLM providers (OpenAI, Anthropic, Gemini, Vertex, Bedrock, etc.)
│   ├── lumihub/                 # Central community hub bridge (LumiHub/LumiSpot)
│   ├── multiplayer/             # Multiplayer identity, attestation, and relay client
│   ├── routes/                  # REST and WebSocket route definitions
│   ├── services/                # Business logic (chats, cortex, databank, vector stores, push)
│   ├── spindle/                 # Extension host runtime, sandboxing, and provider RPC
│   ├── tts/                     # Text-to-speech providers (Cartesia, ElevenLabs, Kokoro, etc.)
│   └── ws/                      # WebSocket event bus and real-time streaming handlers
├── frontend/                    # Web SPA / PWA client (React 19, Vite 8, Zustand)
│   ├── src/                     # React components, hooks, stores, and styles
│   ├── scripts/                 # Props extractor, CSS variables generator
│   └── sw.ts                    # Service Worker implementation for PWA
├── desktop/                     # Tauri v2 Desktop Companion application
│   ├── src/                     # Tray webview logic
│   └── src-tauri/               # Rust Tauri backend (Cargo crate)
├── stream-deck/                 # Elgato Stream Deck plugin subproject
│   ├── src/                     # Plugin logic and Stream Deck SDK bindings
│   └── scripts/                 # Icon renderer and profile builder
├── spindle-extensions/          # Built-in extension suites and SDK packages
├── scripts/                     # Operational scripts (runner, setup wizard, ST migrator)
├── data/                        # Default persistent storage (DB, images, vector data, keys)
├── Dockerfile                   # Multi-stage Debian slim container build
├── docker-compose.yml           # Production Docker compose orchestration
├── bunfig.toml                  # Bun runtime and package manager configuration
└── flake.nix                    # Nix development environment declaration
```

---

## Core Frameworks & Dependencies

### Backend Dependencies (`package.json`)

#### Web Framework & Networking
- **`hono` (`^4.7.0`)**: Lightweight, ultrafast web framework handling all REST endpoints, middleware pipelines, CORS validation, streaming responses, and WebSocket upgrades.
- **`better-auth` (`^1.5.3`)**: Comprehensive authentication framework providing user management, sessions, password hashing, admin roles, and generic OIDC/OAuth2 SSO integrations.
- **`@modelcontextprotocol/sdk` (`^1.29.0`)**: Official SDK for Anthropic Model Context Protocol (MCP), enabling Lumiverse to act as an MCP host connecting to local and remote MCP tool servers.

#### Database & Vector Engines
- **`bun:sqlite` (Built-in)**: Zero-overhead SQLite driver compiled into Bun. Configured with Write-Ahead Logging (`WAL`), dynamic memory mapping (`PRAGMA mmap_size`), query cache optimization, and automated maintenance checkpointing.
- **`@lancedb/lancedb` (`0.29.0`)** & **`apache-arrow` (`18.1.0`)**: Embedded columnar vector database with native glibc bindings. Powers local Memory Cortex, Databank RAG, and World Book vector embeddings.
- **`@zilliz/milvus2-sdk-node` (`^3.0.3`)**: High-performance Node/Bun client for remote enterprise Milvus vector databases.
- *(Qdrant)*: Native HTTP REST client implementation for external Qdrant vector databases.

#### Tokenization & Text Processing
- **`@lenml/tokenizers` (`^3.7.2`)** & **`@lenml/tokenizer-claude` (`^3.7.2`)**: Tokenizer support for Claude / Anthropic models.
- **`gpt-tokenizer` (`^2.8.1`)** & **`js-tiktoken` (`^1.0.16`)**: OpenAI BPE token counting and truncation utilities.
- **`@mozilla/readability` (`^0.6.0`)** & **`jsdom` (`^29.0.1`)**: Standalone DOM parser and article content extractor for web scraping, Databank document ingestion, and Council research tools.

#### Media & Storage
- **`sharp` (`^0.34.5`)**: High-performance libvips image processing for avatar resizing, thumbnail generation, WebP compression, and character card PNG chunk extraction.
- **`archiver` (`^8.0.0`)** & **`fflate` (`^0.8.2`)**: Zip and tar archive generation for full user data exports, character pack imports, and in-memory compression.
- **`ffmpeg-static` (`^5.3.0`)** *(optional)*: Standalone ffmpeg binaries for audio conversion and voice stream transcoding.

#### Communication & System
- **`@pushforge/builder` (`^2.0.1`)**: RFC 8291 / 8292 VAPID Web Push payload encryption and dispatch for background generation alerts.
- **`@opentelemetry/api` (`^1.9.1`)**: Telemetry tracing and performance instrumentation.
- **`@msgpack/msgpack` (`^3.1.2`)**: Binary serialization for Spindle extension IPC and high-throughput WebSocket messages.
- **`ssh2-sftp-client` (`^12.1.1`)**: SFTP client for remote SillyTavern migration sources (opt-in via `LUMIVERSE_ENABLE_SFTP=1`).
- **`lumiverse-spindle-types` (`0.6.15`)**: Type definitions for Spindle extension manifests, worker hooks, UI components, and host APIs.

---

### Frontend Dependencies (`frontend/package.json`)

#### UI Framework & React 19 Ecosystem
- **`react` (`^19.2.6`)** & **`react-dom` (`^19.2.6`)**: Core React 19 UI library utilizing concurrent features, transitions, and native Actions.
- **`babel-plugin-react-compiler` (`^1.0.0`)** & **`@rolldown/plugin-babel` (`0.2.3`)**: Automated fine-grained memoization via the experimental React Compiler in annotation mode (`"use memo"`).
- **`react-router` (`^7.1.1`)**: Client-side routing, route loaders, and navigation state.
- **`zustand` (`^5.0.3`)**: Lightweight state management for active chats, UI settings, themes, audio streams, and WebSocket subscriptions.

#### Specialized UI Components & Editors
- **`@codemirror/*` (`^6.x`)**: Complete CodeMirror 6 code editor suite with JavaScript, CSS, linting, autocomplete, and one-dark themes for extension scripts, prompt templates, and custom CSS styling.
- **`@dnd-kit/core` (`^6.3.1`)**, **`@dnd-kit/sortable` (`^9.0.0`)**, **`@dnd-kit/utilities` (`^3.2.2`)**: Accessible drag-and-drop toolkit for prompt ordering, lorebook entry sorting, and extension UI layout.
- **`@tanstack/react-virtual` (`^3.14.3`)**: High-performance windowing and virtualization for infinite chat message histories, character galleries, and large log viewers.
- **`motion` (`^12.0.0`)**: Modern Framer Motion animation engine for modal transitions, drawer swipes, and fluid UI interactions.
- **`react-easy-crop` (`^5.1.0`)**: Interactive image cropping for avatar uploads and character card art adjustments.

#### Content Rendering & Utility
- **`marked` (`^15.0.4`)**: Markdown parser for assistant responses, lorebooks, and descriptions.
- **`dompurify` (`^3.2.4`)**: Strict HTML sanitization ensuring safe rendering of user/LLM markdown.
- **`highlight.js` (`^11.11.1`)**: Syntax highlighting for code blocks in LLM replies.
- **`fuse.js` (`^7.0.0`)**: Fast client-side fuzzy searching across character lists, world book entries, and prompt presets.
- **`i18next` (`^26.2.0`)**, **`react-i18next` (`^17.0.8`)**, **`i18next-browser-languagedetector` (`^8.2.1`)**: Complete internationalization framework with lazy-loaded translation bundles.
- **`lucide-react` (`^0.468.0`)** & **`@tabler/icons-react` (`^3.41.0`)**: Vector iconography sets.
- **`clsx` (`^2.1.1`)**: Conditional CSS class name constructor.

#### PWA & Service Worker
- **`vite-plugin-pwa` (`^1.3.0`)** & **`workbox-*` (`^7.4.0`)**: Service worker generation with `injectManifest` strategy (`frontend/sw.ts`), supporting offline asset caching, cache busting, and background sync.

---

### Desktop Companion Dependencies (`desktop/package.json` & `Cargo.toml`)

- **`tauri` (`^2.0`)**: Desktop application runtime using system webviews (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS).
- **`tauri-plugin-autostart` (`^2`)**: OS startup registration for system tray operation.
- **`tauri-plugin-opener` (`^2`)**: Default system browser launcher.
- **`tauri-plugin-store` (`^2`)**: Persistent key-value storage for desktop preferences.
- **`window-vibrancy` (`0.6`)** & **`objc2-*`**: macOS native vibrancy, blur, and private window APIs.
- **`serde` & `serde_json` (`1.0`)**: Rust serialization/deserialization for Tauri IPC commands.

---

### Stream Deck Plugin Dependencies (`stream-deck/package.json`)

- **`@elgato/streamdeck` (`^2.0.0`)**: Official Elgato Stream Deck Node.js SDK.
- **`@elgato/cli` (`^1.5.0`)**: Stream Deck plugin packaging and distribution tools.
- **`esbuild` (`^0.25.0`)**: Bundles the plugin into a standalone CommonJS binary (`plugin.cjs`) targeting Node 20.
- **`sharp` (`^0.34.0`)**: Generates custom key icons and dynamic state visuals for deck dials and buttons.

---

## Build & Development Tooling

| Tool | Subproject | Configuration File | Purpose |
|---|---|---|---|
| **Bun** | Root / Backend | `bunfig.toml`, `package.json` | Package management, test execution, server process runner |
| **Vite 8** | Frontend | `frontend/vite.config.ts` | Frontend HMR dev server, React Compiler integration, PWA injection, chunk splitting |
| **Vite 8** | Desktop | `desktop/vite.config.ts` | Multi-page build (`main`, `customUrl`, `widget`) for Tauri webviews |
| **esbuild** | Stream Deck | `stream-deck/package.json` | Fast CJS bundling for the Stream Deck plugin runtime |
| **TypeScript (`tsc`)** | All | `tsconfig.json`, `*/tsconfig.json` | Static type checking and project references (`tsc -b`, `tsc --noEmit`) |
| **ESLint 10** | Frontend / Spindle | `frontend/eslint.config.js` | Flat config linting with `eslint-plugin-react-hooks` and `eslint-plugin-react-compiler` |
| **Docker** | Infrastructure | `Dockerfile`, `docker-compose.yml` | Multi-stage production container build (Debian slim + Bun + LanceDB glibc) |
| **Nix** | Development | `flake.nix` | Hermetic dev shell across x86_64/aarch64 Linux and Darwin |

---

## Configuration & Environment Variables

All runtime configuration is managed through environment variables parsed in `src/env.ts` with sensible defaults. Environment keys are documented in `.env.example`.

### Server & Networking
- `PORT` *(default: 7860)*: TCP port for the Hono backend server.
- `DATA_DIR` *(default: `./data`)*: Base filesystem directory for persistent database files, uploaded media, avatars, extensions, and cryptographic keys.
- `FRONTEND_DIR`: Path to pre-built frontend distribution (e.g. `./frontend/dist`). When provided, backend serves static assets directly.
- `TRUSTED_ORIGINS`: Comma-separated list of allowed CORS origins. Automatically includes localhost, 127.0.0.1, and detected LAN IPv4 addresses.
- `TRUST_ANY_ORIGIN` *(default: false in local, true in Docker)*: Bypasses strict CORS checking for containerized deployments behind reverse proxies.
- `TRUSTED_PROXIES`: Comma-separated IP addresses or CIDR blocks allowed to supply client IPs via `X-Forwarded-For`, `Forwarded`, and `X-Real-IP`.

### Authentication & Cryptography
- `OWNER_USERNAME` *(default: "admin")*: Display name for the initial owner account.
- `AUTH_SECRET`: 32-byte hex secret for Better-Auth session tokens. Auto-derived from `data/lumiverse.identity` if omitted.
- `ENCRYPTION_KEY`: Master AES-256-GCM encryption key for secrets stored in SQLite. Stored in `data/lumiverse.identity`.
- `OWNER_PASSWORD`: *(Legacy)* Used only during automatic migration from legacy `.env` to hashed `data/owner.credentials`.

### Runtime & Performance Tuning
- `LUMIVERSE_SMOL` *(default: true)*: Toggles Bun's `--smol` low-memory GC mode. Keeps low-memory devices (Raspberry Pi, Android/Termux) stable. Set `false` on high-RAM servers for maximum throughput.
- `LUMIVERSE_SQLITE_MMAP_ENABLED` *(default: false)*: Enables memory-mapped I/O (`PRAGMA mmap_size`). Kept disabled by default to eliminate `SIGBUS` risks during filesystem pressure.
- `LUMIVERSE_SAFE_THEME` *(default: false)*: Emergency boot flag that suppresses custom user CSS and component TSX overrides without deleting them.

### Storage & System Diagnostics
- `LUMIVERSE_DISK_WARNING_USAGE_PERCENT` *(default: 0.9 / 90%)*: Disk usage percentage threshold for operational warnings.
- `LUMIVERSE_DISK_WARNING_MIN_FREE_BYTES` *(default: 100 GB)*: Free disk space floor for operational warnings. Both conditions must be met to trigger warnings.
- `LUMIVERSE_SMART_MONITOR` *(default: true if smartctl present)*: Enables background S.M.A.R.T. disk health polling via `smartctl`.
- `LUMIVERSE_SMARTCTL_PATH`: Custom path to the `smartctl` executable.

### Vector Store & AI Overrides
- `LUMIVERSE_VECTOR_STORE_PROVIDER` *(options: `""`, `"lancedb"`, `"qdrant"`, `"milvus"`)*: Forces a vector database backend from environment variables (useful for headless Docker deployments).
- `LUMIVERSE_QDRANT_URL`, `LUMIVERSE_QDRANT_API_KEY`: Connection parameters for Qdrant.
- `LUMIVERSE_MILVUS_ADDRESS`, `LUMIVERSE_MILVUS_USERNAME`, `LUMIVERSE_MILVUS_PASSWORD`, `LUMIVERSE_MILVUS_SSL`: Connection parameters for Milvus.
- `POLLINATIONS_APP_KEY`: Default publishable BYOP application key for Pollinations AI services.

### Spindle Extension Limits
- `SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES` *(default: 500 MB)*: Global memory cap for all ephemeral extension state pools.
- `SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES` *(default: 50 MB)*: Default per-extension memory allocation limit.
- `SPINDLE_EPHEMERAL_RESERVATION_TTL_MS` *(default: 10 minutes)*: TTL for uncommitted extension storage reservations.

### Migrations & Legacy Imports
- `LUMIVERSE_ST_MIGRATE` *(default: false)*: Triggers automated startup migration of SillyTavern data directories.
- `SILLYTAVERN_PATH` *(default: `./data/SillyTavern`)*: Location of the SillyTavern root directory.
- `SILLYTAVERN_TARGET_USER` *(default: `"default-user"`)*: Target Lumiverse username for imported assets.
- `SILLYTAVERN_MIGRATION_TARGET` *(1 to 5, default: 5)*: Migration scope (1=characters, 2=world books, 3=personas, 4=chars+chats, 5=everything).
- `LUMIVERSE_ENABLE_SFTP` *(default: 0)*: Opt-in flag to enable `ssh2` SFTP driver on runtimes with complete POSIX libuv support.

---

## Platform & Hardware Requirements

### Operating Systems
- **Linux**: x86_64, aarch64 (Ubuntu, Debian, Fedora, Arch, NixOS, Alpine container host with glibc container).
- **macOS**: x86_64, Apple Silicon (M1/M2/M3/M4) (macOS 12+).
- **Windows**: Windows 10, Windows 11, Windows Server 2019+ (x64, ARM64 via emulation or native Bun).
- **Android / Termux**: Supported via Bun on Linux arm64 with fallback build flags for native bindings (`@rolldown/binding-android-arm64`, `lightningcss-android-arm64`).

### Runtime & System Library Prerequisites
- **glibc** (`>= 2.31`): Required by the embedded `@lancedb/lancedb` native Arrow vector engine. Alpine/musl is **not supported** for direct host runs; Docker images use Debian Slim (`oven/bun:1.3.14-slim`).
- **OpenSSL / CA Certificates**: Outbound HTTPS connections to LLM providers, OAuth endpoints, and MCP servers require updated system CA certificates (`ca-certificates` package).
- **smartmontools** *(Optional)*: `smartctl` utility for hardware disk health monitoring.

---

*Stack analysis: 2026-08-17*
