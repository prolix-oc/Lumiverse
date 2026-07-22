# Lumiverse

The full stack suite for Lumiverse, a full-featured AI chat application. Provides the data layer, real-time event bus, LLM generation pipeline, and extension runtime.

## Community

Join the conversation on [Discord](https://discord.gg/28rBWVFfCu) for help, updates, and discussion.

Please also review the [Code of Conduct](CODE_OF_CONDUCT.md).

## Documentation

- [User guides](https://lumiverse.chat/guides)
- [Extension developer docs](https://docs.lumiverse.chat)

## Get the Repository

Clone the repo from GitHub. Do **not** use the GitHub **Releases** tab or download a release archive there; those builds are outdated.

```bash
git clone https://github.com/prolix-oc/Lumiverse.git
cd Lumiverse
```

The default clone lands on `main`, which is the usual starting point.

If you specifically need the `staging` branch, switch to it before continuing:

```bash
git switch staging
git pull --ff-only
```

## Tech Stack

- **Runtime** — [Bun](https://bun.sh) (native TypeScript, built-in SQLite, WebSocket, HTTP)
- **Router** — [Hono](https://hono.dev) (Web Standards framework)
- **Database** — `bun:sqlite` (WAL mode, prepared statements, zero ORM)
- **Auth** — [BetterAuth](https://www.better-auth.com) (username/password, role-based access)
- **Encryption** — Web Crypto AES-256-GCM (secrets at rest)
- **WebSocket** — Bun native WS via Hono adapter (real-time events)
- **Image Processing** — [sharp](https://sharp.pixelplumbing.com) (WebP thumbnail generation)

## Quick Start

All commands below assume you have already cloned the repo and are working from the branch you want to run.

### One-line launch (macOS/Linux)

```bash
./start.sh
```

### One-line launch (Windows)

```powershell
.\start.ps1
```

The launcher will:
1. Install Bun if not found
2. Upgrade Bun versions older than 1.3.13 to the latest stable release
3. Run the **first-time setup wizard** (admin account, port, extension storage, optional SMART disk monitoring)
4. Install backend dependencies and serve the existing frontend build if one is available
5. Start the backend with the runner and IPC bridge when launched interactively

Use `./start.sh --build` on macOS/Linux or `.\start.ps1 -Build` on Windows if you want to rebuild the frontend before starting.

### Manual setup

If you use **Nix** or **NixOS** with flakes enabled, enter the bundled dev shell first:

```bash
nix develop
```

```bash
# Install dependencies
bun install

# Run the setup wizard
bun run setup

# Start with the IPC-enabled runner
bun run runner

# Start with the IPC-enabled runner in watch mode
bun run runner:dev

# Start in development mode (watch)
bun run dev

# Start in production mode
bun run start
```

`bun run start` and `bun run dev` launch the backend directly. If you want the owner-only `Settings -> Operator Panel` controls, start Lumiverse with `./start.sh`, `.\start.ps1`, `bun run runner`, or `bun run runner:dev`.

### Hugging Face Spaces (free hosting)

You can run Lumiverse for free on [Hugging Face Spaces](https://huggingface.co/spaces) using a Docker Space.

> **Free-tier limits:** Spaces on the free tier run on 2 vCPU / 16 GB RAM with no GPU. The container sleeps after **48 hours of inactivity** and cold-starts on the next visit (typically 30–60 s). Persistent storage buckets are **free** and keep your data across restarts — attach one in **Settings → Persistent storage**. For always-on, full-speed inference consider a paid Space or a dedicated server.

#### 1. Create a new Space

1. Go to [huggingface.co/new-space](https://huggingface.co/new-space).
2. Give it a name, set **Space SDK** to **Docker**, and set **Visibility** to *Public* or *Private*.
3. Click **Create Space**.

#### 2. Add persistent storage

In your Space's **Settings → Persistent storage**, attach a storage bucket and mount it at `/app/data`.

#### 3. Add the Dockerfile

In the **Files** tab of your Space, create a file named `Dockerfile` with the following contents:

```dockerfile
FROM oven/bun:1-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  git ca-certificates curl sqlite3 rsync python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG LUMIVERSE_REPO=https://github.com/prolix-oc/Lumiverse.git
ARG LUMIVERSE_REF=staging
RUN git clone --depth 1 --branch "${LUMIVERSE_REF}" "${LUMIVERSE_REPO}" .

RUN rm -f package-lock.json && bun install --production

WORKDIR /app/frontend
RUN rm -f package-lock.json && bun install && bun run build
RUN printf "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));\n" > /app/frontend/dist/sw.js
RUN test -f /app/frontend/dist/index.html

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV FRONTEND_DIR=/app/frontend/dist
ENV TRUST_ANY_ORIGIN=true
ENV OWNER_PASSWORD=admin123

RUN cat > /app/start.sh <<'SH'
#!/usr/bin/env sh
set -eu
export DATA_DIR="${DATA_DIR:-/app/data}"
exec bun run scripts/runner.ts
SH

RUN chmod +x /app/start.sh

USER root
RUN mkdir -p /app/data && chown -R bun:bun /app/data

EXPOSE 7860
VOLUME /app/data

USER bun
CMD ["/app/start.sh"]
```

#### 4. Set your admin password

Before the Space builds, go to **Settings → Variables and secrets** and add a secret:

| Name | Value |
|------|-------|
| `OWNER_PASSWORD` | *your chosen password* |

This overrides the `admin123` default baked into the Dockerfile. **Do not skip this step on a public Space.**

#### 5. Open the Space

Once the build finishes (~3–5 min on the free tier), click **Open in new tab** (or visit `https://<your-username>-<space-name>.hf.space`). Log in with username `admin` and the password you set.

## First-Run Setup

On first launch, the setup wizard walks you through:

1. **Admin account** — username and password for the owner account
2. **Server port** — defaults to `7860`
3. **Extension storage** — disk budget for Spindle extension data pools
4. **Disk health monitoring** — installs smartmontools through the detected system package manager when possible
5. **Identity file** — auto-generated encryption identity (`data/lumiverse.identity`)

The wizard produces a `.env` file and the identity file. Both are required to run the server.

> **Important:** Keep `data/lumiverse.identity` safe. It holds the encryption key for all secrets. If lost, encrypted data cannot be recovered.

### SMART disk health

Lumiverse checks physical-drive SMART health with the optional `smartctl` binary. The setup wizard installs it by default on supported package managers; existing installations can run `bun run install:smartctl`. The owner/admin Operator API exposes `GET /api/v1/operator/smartctl` and `POST /api/v1/operator/smartctl/install`.

The Operator panel recognizes NVMe and SATA SSDs and shows the fields their controller actually exposes: endurance used/remaining, spare capacity, data written, power-on hours/cycles, media errors, unsafe shutdowns, wear-leveling, reserved blocks, and program/erase failures. Rotating HDDs additionally show power-on hours, power cycles, start/stop cycles, and load/unload cycles. ATA SMART attributes are vendor-specific, so unavailable values are omitted rather than guessed. Exhausted endurance, depleted NVMe spare capacity, integrity errors, or program/erase failures raise a warning.

When a periodic SMART check finds a failed or pre-fail condition, connected owners and admins receive one Disk Health toast per browser page load. The alert names the affected drive and the actual SMART evidence; later checks re-emit it for operators who connect after startup.

On Linux, disk access and installation normally require local administrator permission. Docker images include smartmontools, but you must explicitly map the host block devices you intend to monitor; a container without device access will report SMART as unavailable. The monitor skips standby drives to avoid waking them and can be disabled with `LUMIVERSE_SMART_MONITOR=false`.

### Encryption & Auth Keys

- The **identity file** (`data/lumiverse.identity`) is auto-generated on first run and handles AES-256-GCM encryption for stored secrets.
- **AUTH_SECRET** for session signing is automatically derived from the identity key. No manual key generation step is needed. You can override it in `.env` if desired.

## Launcher Options

### Common launch modes

| macOS / Linux | Windows | Description |
|---------------|---------|-------------|
| `./start.sh` | `.\start.ps1` | Start the backend and serve the existing frontend build if present |
| `./start.sh --build` | `.\start.ps1 -Build` | Rebuild the frontend before starting |
| `./start.sh --build-only` | `.\start.ps1 -Mode build-only` | Build the frontend only |
| `./start.sh --backend-only` | `.\start.ps1 -Mode backend-only` | Start the backend only, skip frontend serving |
| `./start.sh --dev` | `.\start.ps1 -Mode dev` | Start the backend in watch mode |
| `./start.sh --setup` | `.\start.ps1 -Mode setup` | Run the setup wizard only |
| `./start.sh --no-runner` | `.\start.ps1 -NoRunner` | Start directly without runner IPC or Operator Panel control hooks |

### Runner & Operator Panel

When Lumiverse is started through the runner (`./start.sh`, `.\start.ps1`, or `bun run runner`), the backend runs as a child process with runner IPC enabled.

In an interactive terminal, the runner keeps a lightweight local session open for logs and a couple of local shortcuts:

- `O` opens the app in your browser
- `Q` or `Ctrl+C` shuts the runner down gracefully

Most operational controls now live in the owner-only `Settings -> Operator Panel` in the web UI. Over runner IPC, it can:

- Check for and apply updates
- Switch between supported Git branches
- Restart or shut down the server
- Clear Bun's package cache and reinstall dependencies
- Rebuild the frontend
- Toggle remote mode and restart to apply it

If you start Lumiverse with `--no-runner`, `-NoRunner`, `bun run start`, or `bun run dev`, the Operator Panel still loads but runner-backed controls will be unavailable.

### Experimental Lumiverse Desktop

[`desktop/`](desktop/) contains an optional experimental Tauri v2 desktop app
with Lumiverse's integrated browser as its primary interface and a macOS menu
bar / Windows system tray / Linux StatusNotifier icon for controls. It starts
and stops a local server, shows serving stats, opens the same address in your
default browser on request, and applies updates through the runner. See
[desktop/README.md](desktop/README.md) for build instructions.

## Configuration

Configuration is managed through `.env` (see `.env.example` for all options). Sensitive credentials are stored securely in the `data/` directory — no plaintext passwords in `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `7860` | Server port |
| `OWNER_USERNAME` | No | `admin` | Admin account display name |
| `AUTH_SECRET` | No | *derived* | Session signing secret (auto-derived from identity file) |
| `FRONTEND_DIR` | No | — | Path to built frontend dist for static serving |
| `TRUSTED_ORIGINS` | No | `localhost` | Comma-separated CORS origins |

Owner password is stored hashed in `data/owner.credentials` (created by the setup wizard). To reset: `bun run reset-password`.

## Architecture

```
Routes (Hono handlers) → Services (business logic) → DB (bun:sqlite singleton)
```

- **Routes** (`src/routes/`) — Thin HTTP handlers. Parse input, call service, return JSON.
- **Services** (`src/services/`) — All business logic. Database queries, validation, WS event emission.
- **DB** (`src/db/`) — SQLite singleton with WAL mode. Sequential SQL migrations in `src/db/migrations/`.
- **LLM** (`src/llm/`) — Provider abstraction supporting 19 providers with capability metadata and parameter schemas.
- **WS** (`src/ws/`) — EventBus for real-time broadcast and in-process listeners.
- **Auth** (`src/auth/`) — BetterAuth integration with role-based access (owner, admin, user).
- **Macros** (`src/macros/`) — Template resolution engine for prompt assembly.
- **Spindle** (`src/spindle/`) — Extension runtime with Bun Workers, permission system, and storage pools.

## API

All REST endpoints live under `/api/v1`. WebSocket connects at `/api/ws`.

### Core Resources

| Resource | Endpoint | Description |
|----------|----------|-------------|
| Characters | `/api/v1/characters` | Character cards (V1/V2/V3 import, avatar management) |
| Chats | `/api/v1/chats` | Chat sessions with message history and branching |
| Personas | `/api/v1/personas` | User personas with avatar and world book attachment |
| World Books | `/api/v1/world-books` | Lorebooks with keyword-activated entries |
| Presets | `/api/v1/presets` | LLM generation presets (parameters, prompt blocks) |
| Connections | `/api/v1/connections` | Provider connection profiles with per-connection API keys |
| Settings | `/api/v1/settings` | Key-value application settings |
| Secrets | `/api/v1/secrets` | AES-256-GCM encrypted secret storage |
| Images | `/api/v1/images` | Image storage with auto-generated WebP thumbnails |
| Files | `/api/v1/files` | General file upload/download |

### Generation

| Endpoint | Description |
|----------|-------------|
| `POST /api/v1/generate` | Start LLM generation (streams tokens over WebSocket) |
| `POST /api/v1/generate/regenerate` | Regenerate last response |
| `POST /api/v1/generate/continue` | Continue last response |
| `POST /api/v1/generate/stop` | Stop active generation(s) |
| `POST /api/v1/generate/dry-run` | Assemble prompt without calling the LLM |
| `POST /api/v1/generate/raw` | Direct LLM call (localhost only) |
| `POST /api/v1/generate/quiet` | Silent generation via connection profile (localhost only) |
| `POST /api/v1/generate/batch` | Batch generation requests (localhost only) |

### Supported LLM Providers

OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Chutes, NanoGPT, Z.AI, Moonshot, Mistral, AI21, Perplexity, Groq, xAI, ElectronHub, Fireworks, Pollinations, SiliconFlow, and Custom (any OpenAI-compatible endpoint).

### Other Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/v1/packs` | Content packs (Lumia council members, Loom narrative items, tools) |
| `/api/v1/council` | Council settings and tool configuration |
| `/api/v1/image-gen` | AI image generation (Google Gemini, NanoGPT, NovelAI) |

## WebSocket Events

Connect to `ws://localhost:7860/api/ws`. Events are broadcast as JSON:

```json
{ "event": "EVENT_TYPE", "payload": { ... }, "timestamp": 1709500000000 }
```

Key events: `GENERATION_STARTED`, `STREAM_TOKEN_RECEIVED`, `GENERATION_ENDED`, `MESSAGE_SENT`, `MESSAGE_EDITED`, `CHARACTER_EDITED`, `SETTINGS_UPDATED`, and more.

## Project Structure

```
src/
  index.ts              Entry point
  app.ts                Hono app with middleware and route mounting
  env.ts                Environment configuration
  auth/                 BetterAuth setup, middleware, seeding
  crypto/               Identity file management, encryption
  db/                   SQLite connection, migration runner
    migrations/         Sequential SQL migration files
  llm/                  LLM provider abstraction
    providers/          19 provider implementations
  macros/               Template macro engine
    definitions/        Macro definition files by category
  routes/               Hono route handlers
  services/             Business logic and database operations
  spindle/              Extension runtime (workers, permissions, storage)
  types/                Shared TypeScript interfaces
  ws/                   WebSocket event bus and handler
scripts/
  setup-wizard.ts       First-run interactive setup
  runner.ts             IPC-enabled launcher entrypoint
  runner/               Runner internals (IPC, git ops, server lifecycle)
  ui.ts                 Shared terminal UI components
```

## License

[Lumiverse Community License v2.0](LICENSE.md) — source-available for personal, academic, and non-profit use. See the license for full terms.
