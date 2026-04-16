# Installation

Lumiverse runs on your own machine. It needs **Bun** (a fast JavaScript runtime) and takes about two minutes to set up.

---

## Requirements

- **Bun** v1.1 or later — [Install Bun](https://bun.sh) (the start scripts auto-install Bun if it's missing)
- A modern web browser (Chrome, Firefox, Edge, Safari)
- An API key from at least one AI provider (OpenAI, Anthropic, Google, etc.)

!!! note "Operating Systems"
    Lumiverse works on **macOS**, **Linux**, **Windows**, and **Termux** (Android).

---

## Install & Run

### 1. Clone the repository

```bash
git clone https://github.com/prolix-oc/Lumiverse.git
cd Lumiverse
```

### 2. Start the server

=== "macOS / Linux"

    ```bash
    chmod +x start.sh
    ./start.sh
    ```

=== "Windows"

    !!! warning "Windows shell requirements"
        You **must** use **Terminal** (Windows 11) or **PowerShell** (Windows 10). Command Prompt (`cmd.exe`) is not supported.

        If this is your first time running PowerShell scripts, unblock script execution first:

        ```powershell
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
        ```

    ```powershell
    .\start.ps1
    ```

    Alternatively, double-click `lumiverse.bat` — it launches `start.ps1` automatically.

=== "Termux (Android)"

    ```bash
    chmod +x start.sh
    ./start.sh
    ```

    The script auto-detects Termux and installs required packages (`glibc-repo`, `glibc-runner`, `proot`). It uses a three-tier execution strategy to find the best way to run Bun on your device.

=== "Docker"

    See [Docker Installation](#docker) below.

The start script handles everything: auto-installs Bun if needed, runs `bun install`, triggers the setup wizard on first launch, and starts the server.

### 3. Open in your browser

Navigate to `http://localhost:7860`. On first launch, the setup wizard guides you through account creation.

---

## First-Run Setup Wizard

The setup wizard runs automatically on first launch. It walks through four steps:

1. **Admin Account** — Set a username (default: `admin`) and password (minimum 8 characters)
2. **Server Port** — Choose a port (default: `7860`)
3. **Extension Storage** — Set the maximum storage for extensions (default: 500 MB)
4. **Identity Generation** — Creates `data/lumiverse.identity` (your encryption key) and `data/owner.credentials`

You can also run the wizard manually:

```bash
./start.sh --setup
```

!!! warning "Back up your `data/` folder"
    The `data/` directory contains your database, encryption key, credentials, and uploaded images. If you lose the encryption key, you cannot recover your stored API keys. Copy this folder somewhere safe.

---

## Start Script Options

The start scripts accept flags to control behavior:

=== "macOS / Linux (`start.sh`)"

    | Flag | Description |
    |------|-------------|
    | *(no flags)* | Start normally (frontend + backend) |
    | `-b`, `--build` | Rebuild frontend before starting |
    | `--build-only` | Rebuild frontend only, don't start |
    | `--backend-only` | Start backend only, skip frontend |
    | `--dev` | Watch mode (auto-reload on changes) |
    | `--setup` | Run the setup wizard |
    | `--reset-password` | Reset the owner account password |
    | `-m`, `--migrate-st` | Run the [SillyTavern migration](#migrating-from-sillytavern) tool |
    | `--no-runner` | Start without the visual terminal runner |

=== "Windows (`start.ps1`)"

    | Flag | Description |
    |------|-------------|
    | *(no flags)* | Start normally |
    | `-Build` or `-b` | Rebuild frontend before starting |
    | `-Mode build-only` | Rebuild frontend only |
    | `-Mode backend-only` | Start backend only |
    | `-Mode dev` | Watch mode |
    | `-Mode setup` | Run the setup wizard |
    | `-Mode reset-password` | Reset the owner account password |
    | `-MigrateST` or `-m` | Run the SillyTavern migration tool |
    | `-NoRunner` | Start without the visual runner |

---

## Docker

Lumiverse provides pre-built Docker images for the simplest possible deployment.

### Quick Start (Pre-Built Image)

```bash
docker-compose up -d
```

Edit `docker-compose.yml` to set your owner password and any other configuration. Any supported application `.env` value can also be passed here through Docker `environment:` entries:

```yaml
services:
  lumiverse:
    image: ghcr.io/prolix-oc/lumiverse:latest
    container_name: lumiverse
    ports:
      - "7860:7860"
    environment:
      - OWNER_PASSWORD=changeme123    # Required — minimum 8 characters
      - OWNER_USERNAME=admin          # Optional
      - PORT=7860
      - TRUST_ANY_ORIGIN=true

      # Optional app-level env values
      # - DATA_DIR=/app/data
      # - AUTH_SECRET=
      # - ENCRYPTION_KEY=
      # - SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES=524288000
      # - SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES=52428800
      # - SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES=example.extension:104857600
      # - SPINDLE_EPHEMERAL_RESERVATION_TTL_MS=600000

      # Optional one-time SillyTavern migration
      # - LUMIVERSE_ST_MIGRATE=true
      # - SILLYTAVERN_PATH=/app/data/SillyTavern
      # - SILLYTAVERN_TARGET_USER=default-user
      # - SILLYTAVERN_MIGRATION_TARGET=5
      # - LUMIVERSE_FORCE_NEW_MIGRATION=false
    volumes:
      - lumiverse-data:/app/data
      # - /path/to/SillyTavern:/app/data/SillyTavern:ro
    restart: unless-stopped

volumes:
  lumiverse-data:
```

### Build from Source

If you want to build the image locally:

```bash
docker-compose -f docker-compose.build.yml up -d
```

### Docker Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNER_PASSWORD` | *(required)* | Owner account password (min 8 chars) |
| `OWNER_USERNAME` | `admin` | Owner account username |
| `PORT` | `7860` | Server port |
| `DATA_DIR` | `./data` | Data directory inside the container |
| `TRUST_ANY_ORIGIN` | `true` | Accept requests from any origin |
| `TRUSTED_ORIGINS` | — | Comma-separated allowed origins (for production) |
| `AUTH_SECRET` | auto-derived | Explicit auth signing secret; usually leave unset |
| `ENCRYPTION_KEY` | auto-generated | Legacy/manual encryption key override; usually leave unset |
| `SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES` | `524288000` | Total extension storage limit in bytes |
| `SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES` | `52428800` | Default per-extension storage limit in bytes |
| `SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES` | — | Per-extension storage overrides as `extension.id:maxBytes,...` |
| `SPINDLE_EPHEMERAL_RESERVATION_TTL_MS` | `600000` | Extension storage reservation TTL in milliseconds |
| `LUMIVERSE_ST_MIGRATE` | `false` | Run a one-time SillyTavern import during startup |
| `SILLYTAVERN_PATH` | `./data/SillyTavern` | Path to the bind-mounted SillyTavern root |
| `SILLYTAVERN_TARGET_USER` | `default-user` | SillyTavern user folder to import from |
| `SILLYTAVERN_MIGRATION_TARGET` | `5` | Import scope: `1=chars`, `2=world books`, `3=personas`, `4=chars+chats`, `5=everything` |
| `LUMIVERSE_FORCE_NEW_MIGRATION` | `false` | Re-run Docker migration even after a previous success |

### Docker SillyTavern Migration

If you are moving from an existing SillyTavern install, Lumiverse can perform a one-time import automatically when the container starts.

```yaml
services:
  lumiverse:
    environment:
      - OWNER_PASSWORD=changeme123
      - LUMIVERSE_ST_MIGRATE=true
      - SILLYTAVERN_PATH=/app/data/SillyTavern
      - SILLYTAVERN_TARGET_USER=default-user
      - SILLYTAVERN_MIGRATION_TARGET=5
    volumes:
      - lumiverse-data:/app/data
      - /path/to/SillyTavern:/app/data/SillyTavern:ro
```

* Use a read-only bind mount for the SillyTavern folder. Lumiverse only reads from it and does not modify the source data.
* The importer supports both newer SillyTavern layouts (`data/<user>/`) and older installs that still use `public/`.
* `SILLYTAVERN_MIGRATION_TARGET` controls what gets imported:
    * `1` = characters only
    * `2` = world books only
    * `3` = personas only
    * `4` = characters and chat history (including group chats)
    * `5` = everything
* Migration state is saved after a successful run, so later container restarts skip it automatically.
* Set `LUMIVERSE_FORCE_NEW_MIGRATION=true` only when you intentionally want to run the import again.

### Data Persistence

The Docker setup uses a named volume (`lumiverse-data`) mounted at `/app/data`. This persists your database, encryption key, credentials, uploaded images, and extensions across container restarts.

!!! tip "Backup"
    Back up the Docker volume regularly. Use `docker cp` or mount a host directory instead of a named volume if you prefer direct file access.

---

## Configuration

Lumiverse uses a `.env` file for runtime configuration (created by the setup wizard). Common options:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7860` | Server port |
| `DATA_DIR` | `./data` | Override the data directory location |
| `TRUSTED_ORIGINS` | — | CORS origins (comma-separated) |
| `TRUST_ANY_ORIGIN` | `false` | Accept requests from any origin |
| `FRONTEND_DIR` | — | Custom path to frontend dist folder |
| `SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES` | `524288000` | Extension storage limit (500 MB) |
| `SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES` | `52428800` | Default per-extension storage limit |
| `SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES` | — | Per-extension storage overrides as `extension.id:maxBytes,...` |
| `SPINDLE_EPHEMERAL_RESERVATION_TTL_MS` | `600000` | Extension storage reservation TTL in milliseconds |
| `AUTH_SECRET` | auto-derived | Explicit auth signing secret |
| `ENCRYPTION_KEY` | auto-generated | Legacy/manual encryption key override |

API keys and account passwords are stored encrypted in the `data/` directory rather than in `.env`. Leave `AUTH_SECRET` and `ENCRYPTION_KEY` unset unless you are intentionally carrying forward an existing install.

---

## Updating

=== "Visual Runner"

    If you're using the visual terminal runner (the default), press **U** twice to trigger an update. The runner pulls the latest code, reinstalls dependencies, and restarts automatically.

=== "macOS / Linux"

    ```bash
    git pull
    ./start.sh
    ```

=== "Windows"

    ```powershell
    git pull
    .\start.ps1
    ```

=== "Docker"

    ```bash
    docker-compose pull
    docker-compose up -d
    ```

Database migrations run automatically on startup — your data is preserved across updates.

---

## Migrating from SillyTavern

If you're coming from SillyTavern, Lumiverse includes a migration tool that imports your characters, chat history, world books, and personas. You can migrate from a local directory, or connect to a remote machine over **SFTP** or **SMB** if your SillyTavern installation lives on another device.

### Running the Migration

There are two ways to run the migration:

#### Web UI (recommended)

Open Lumiverse, go to **Settings > Migration**, and follow the wizard. This is the easiest approach and supports all three connection methods (Local, SFTP, SMB).

#### CLI

=== "macOS / Linux"

    ```bash
    ./start.sh --migrate-st
    ```

=== "Windows"

    ```powershell
    .\start.ps1 -MigrateST
    ```

=== "Direct"

    ```bash
    bun run migrate:st
    ```

!!! note
    The CLI migration only supports local directories. For SFTP or SMB sources, use the web UI.

### Connection Methods

The web migration wizard lets you choose how to access your SillyTavern data:

#### Local

Browse directories on the machine running Lumiverse. This is the default and requires no extra setup.

#### SFTP (SSH File Transfer)

Connect to a remote machine over SSH. Useful when SillyTavern is on a VPS, home server, or any machine you can SSH into.

- **Authentication**: Password or private key (upload a `.pem`/`.key` file or paste it directly)
- **Requirements**: An SSH server running on the remote machine (standard on Linux/macOS)

#### SMB (Samba / Windows Shares)

Connect to a network share. Useful when SillyTavern data is on a NAS (Synology, TrueNAS, QNAP, etc.), a Windows PC, or any Samba share.

- **Authentication**: Username/password, with optional domain
- **Requirements**: The `smbclient` package must be installed on the machine running Lumiverse

!!! info "SMB availability"
    The SMB option only appears in the UI if `smbclient` is detected on your system. If you don't see it, install the appropriate package for your OS (see below).

##### Installing smbclient

=== "Debian / Ubuntu"

    ```bash
    sudo apt install smbclient
    ```

=== "Fedora / RHEL"

    ```bash
    sudo dnf install samba-client
    ```

=== "Arch Linux"

    ```bash
    sudo pacman -S smbclient
    ```

=== "Alpine"

    ```bash
    sudo apk add samba-client
    ```

=== "macOS (Homebrew)"

    ```bash
    brew install samba
    ```

=== "Termux (Android)"

    ```bash
    pkg install samba
    ```

!!! tip "Windows users"
    You don't need SMB support on Windows — network shares like `\\server\share` are native filesystem paths. Just use the **Local** connection mode and type the UNC path directly.

### Migration Walkthrough

The web UI wizard walks you through these steps:

1. **Choose connection** — Select Local, SFTP, or SMB and enter credentials if needed. For remote connections, click **Test Connection** to verify before proceeding.
2. **Browse & validate** — Navigate to your SillyTavern root directory (the folder containing the `data/` subfolder) and click **Validate**.
3. **Select ST user** — If your SillyTavern has multiple user profiles, choose which one to migrate.
4. **Select scope** — Choose what to import:
    - Characters only
    - World Books only
    - Personas only
    - Characters + Chat History (including group chats)
    - Everything (recommended)
    - Custom selection
5. **Select target** — Choose which Lumiverse account receives the data.
6. **Confirm & import** — Review the summary and start the migration. Progress and logs stream in real time.
7. **Results** — See counts of imported, skipped, and failed items.

### What Gets Imported

| Content | Source | Notes |
|---------|--------|-------|
| **Characters** | PNG files with embedded card data | Avatars are extracted and uploaded automatically |
| **Chat History** | Per-character JSONL chat files | Message content, swipes, timestamps, and metadata preserved |
| **Group Chats** | ST group chat data | Multi-character conversation history |
| **World Books** | JSON world info files | All entries with keywords, positions, and settings |
| **Personas** | ST `settings.json` | Names, descriptions, and avatar images |

!!! tip "Run Lumiverse first"
    The migration tool connects to a running Lumiverse instance via API. Make sure Lumiverse is running before starting the migration.

!!! tip "Checkpoint resume (CLI)"
    If the CLI import is interrupted (network issue, crash), run it again. The tool detects the checkpoint file and offers to resume where it left off instead of starting over.

!!! tip "Duplicate detection"
    Previously imported characters are automatically skipped, so it's safe to run the migration more than once.

---

## Next Steps

Once Lumiverse is running, head to [First Steps](first-steps.md) to connect your first AI provider and start chatting.
