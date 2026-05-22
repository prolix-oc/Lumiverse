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
    | `--no-runner` | Start without the runner (disables Operator Panel update/restart/branch-switch controls) |
    | `--upgrade-bun` | Upgrade Bun to the latest stable release, then continue |
    | `--upgrade-bun-canary` | Upgrade Bun to the latest canary build, then continue |

    !!! note "Termux behavior"
        Bun's built-in `bun upgrade` command does not work on native Termux — it aborts with `'bun upgrade' is unsupported on systems without ld` because Termux uses Android's bionic libc, not glibc. On Termux:

        * `--upgrade-bun` rebuilds the [`bun-termux`](https://github.com/Happ1ness-dev/bun-termux) wrapper at `$HOME/.bun-termux` (`git pull && make && make install`), which is the actual source of Bun on Termux.
        * `--upgrade-bun-canary` is **not supported** — bun-termux only packages stable releases. The start script will skip the upgrade and continue with the existing binary. If you specifically need canary, run Lumiverse inside a [proot-distro Linux](https://github.com/termux/proot-distro) environment, where standard `bun upgrade --canary` works normally.

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
    | `-NoRunner` | Start without the runner (disables Operator Panel update/restart/branch-switch controls) |
    | `-UpgradeBun` | Upgrade Bun to the latest stable release, then continue |
    | `-UpgradeBunCanary` | Upgrade Bun to the latest canary build, then continue |

---

## Docker

Lumiverse provides pre-built Docker images for the simplest possible deployment.

### Available Image Tags

Pre-built images are published to GitHub Container Registry under `ghcr.io/prolix-oc/lumiverse`:

| Tag | Built From | Cadence | Audience |
|-----|------------|---------|----------|
| `latest` | `main` branch | Tagged releases | Default for everyone. Most stable. |
| `staging` | `staging` branch | **Daily at 05:00 UTC** | Users who want a daily preview of upcoming work. May ship rough edges. |
| `staging-<sha>` | `staging` branch | Daily | Specific commit pins of the staging branch — useful for rolling back if a fresh staging build regresses. |

Switching between tags is just a matter of editing the `image:` line in `docker-compose.yml` and running `docker-compose pull && docker-compose up -d`. Your `lumiverse-data` volume is untouched, so your database and settings carry over between tags.

!!! tip "Tracking staging without rebuilding"
    Before the daily-build workflow existed, the only way to follow `staging` in Docker was to rebuild from source with `docker-compose.build.yml`. That still works, but if you just want the latest staging changes once a day, swap the image to `ghcr.io/prolix-oc/lumiverse:staging` and run `docker-compose pull` — no local build required.

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

#### Forcing a fresh frontend bundle

The build pipeline uses Docker's layer cache, so if Docker doesn't see a meaningful change in the frontend inputs it will reuse the previously baked Vite bundle. This is normally what you want — but if you're tracking the `staging` branch (or anywhere else fast-moving), you may want to guarantee the bundle was rebuilt from your current checkout before it gets packaged into the image.

The build accepts a `FRONTEND_REFRESH` build arg that cache-busts the Vite build layer without invalidating apt, the CA refresh, or backend dependencies:

=== "macOS / Linux"

    ```bash
    FRONTEND_REFRESH=$(date -u +%s) docker compose -f docker-compose.build.yml build
    docker compose -f docker-compose.build.yml up -d
    ```

=== "Windows (PowerShell)"

    ```powershell
    $env:FRONTEND_REFRESH = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    docker compose -f docker-compose.build.yml build
    docker compose -f docker-compose.build.yml up -d
    ```

Any value different from the last build will do — the timestamp examples above are just an easy way to guarantee uniqueness.

!!! tip "Staging users"
    `staging` ships frontend changes more frequently than `main`. If you build the image right after a `git pull` and don't see your latest UI work in the running container, run the `FRONTEND_REFRESH` invocation above to force the Vite stage to rerun. A sibling `CA_REFRESH` arg works the same way for the CA trust store — useful if you hit "unable to verify the first certificate" errors talking to providers:

    ```bash
    CA_REFRESH=$(date -u +%G-W%V) FRONTEND_REFRESH=$(date -u +%s) \
      docker compose -f docker-compose.build.yml build
    ```

If you'd rather throw away the cache entirely (slower, but belt-and-braces), pass `--no-cache` to `docker compose build` instead.

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

The easiest way to update Lumiverse is from the **Operator Panel** in the running app — no terminal interaction needed.

### From the Operator Panel (recommended)

1. Open **Settings → Operator Panel**.
2. Click **Check for Updates**. The panel reports how many commits behind you are and previews the latest commit message.
3. If an update is available, click **Apply Update**. Lumiverse pulls the latest code, reinstalls dependencies, rebuilds the frontend, and restarts the server. Your browser reconnects automatically when the new build is ready.

The runner that the start scripts launch is what carries out the update on your behalf. It needs to be attached for the Operator Panel buttons to work — the panel shows **Runner IPC: Connected** when it is. If the badge reads _Unavailable_ (e.g. you launched with `--no-runner` / `-NoRunner`, or restarted the backend outside the runner), use the command-line flow below instead.

### From the Command Line

=== "macOS / Linux"

    ```bash
    git pull
    ./start.sh --build
    ```

=== "Windows"

    ```powershell
    git pull
    .\start.ps1 -Build
    ```

=== "Docker"

    ```bash
    docker-compose pull
    docker-compose up -d
    ```

The `--build` / `-Build` flag rebuilds the frontend before launching — important on a fresh pull because the precompiled assets won't match the new source.

Database migrations run automatically on startup — your data is preserved across updates.

---

## Switching Branches

Lumiverse ships two long-lived branches:

| Branch | Cadence | Audience |
|--------|---------|----------|
| **`main`** | Tagged releases. Most stable. | Default for everyone. |
| **`staging`** | Receives merged work earlier than `main`. May ship rough edges or in-progress features. | Users who want a preview of upcoming changes and don't mind the occasional regression. |

You can move between branches at any time. Your `data/` folder is unaffected.

### From the Operator Panel (recommended)

If you launched Lumiverse with one of the start scripts, the runner is attached by default and you can switch branches without leaving the app:

1. Open **Settings → Operator Panel**.
2. Look at the **Branch** card — it shows the branch you're on (`main` or `staging`).
3. Click **Switch to staging** (or **Switch to main** if you're already on staging).
4. Confirm the prompt. Lumiverse will checkout, pull, reinstall, rebuild the frontend, and restart the server. Your browser will reconnect automatically when the new build is up.

!!! note "Runner IPC must be connected"
    The button is disabled when the **Runner IPC** badge in the Operator Panel reads _Unavailable_. The runner is what executes the checkout/pull/rebuild on your behalf. If you launched without the runner (`--no-runner` / `-NoRunner`), restart with it enabled or use the git command flow below.

### From the Command Line

=== "macOS / Linux"

    ```bash
    git fetch origin
    git checkout staging      # or: git checkout main
    git pull
    ./start.sh --build
    ```

=== "Windows"

    ```powershell
    git fetch origin
    git checkout staging      # or: git checkout main
    git pull
    .\start.ps1 -Build
    ```

The `--build` / `-Build` flag rebuilds the frontend before launching — important when switching branches because the precompiled assets differ.

!!! warning "Docker users"
    The Operator Panel's branch switch and the `git checkout` flow both assume Lumiverse is running from a git checkout. If you're using a pre-built Docker image, there is no working tree to switch — instead, change the `image:` line in `docker-compose.yml`:

    * `ghcr.io/prolix-oc/lumiverse:latest` → `main` branch (tagged releases)
    * `ghcr.io/prolix-oc/lumiverse:staging` → `staging` branch (rebuilt daily at 05:00 UTC)

    Then `docker-compose pull && docker-compose up -d`. If you need staging changes published *between* daily builds, fall back to rebuilding from source with `docker-compose -f docker-compose.build.yml up -d` after `git checkout staging` — and pass `FRONTEND_REFRESH=$(date -u +%s)` so the Vite bundle is regenerated from your fresh checkout (see [Forcing a fresh frontend bundle](#forcing-a-fresh-frontend-bundle)).

!!! tip "Roll back to main if staging breaks"
    Staging can occasionally ship a regression. Switching back to `main` from the Operator Panel (or `git checkout main && ./start.sh --build`) returns you to the last stable release without touching your `data/` folder.

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
6. **(Optional) TagLibrary Backup** — If you used the [SillyTavern-TagLibrary](https://github.com/Inkbottle007/SillyTavern-TagLibrary) extension and exported a JSON backup, upload it here. Lumiverse will re-apply your tags to the imported characters once the main migration finishes. See [TagLibrary Re-Apply](#taglibrary-re-apply) below.
7. **Confirm & import** — Review the summary and start the migration. Progress and logs stream in real time.
8. **Results** — See counts of imported, skipped, and failed items.

### TagLibrary Re-Apply

The standalone **TagLibrary** extension for SillyTavern stores its character tags outside the character card itself, so they are *not* part of a normal SillyTavern export. Lumiverse can pull them back in:

1. In SillyTavern, open the TagLibrary extension and export your backup as JSON
2. On the **Confirm** step of the Migration wizard, expand **Optional: TagLibrary Backup** and upload the JSON file
3. After the main migration completes, Lumiverse automatically runs the TagLibrary import and matches tags to imported characters using their source filenames and original image filenames

A toast reports the results — how many tags were applied, how many were skipped because no matching character was found, and how many failed to parse. Existing character tags are preserved; the import only *adds* tags, it never removes them.

!!! tip "When to use this"
    Only relevant if you ran the SillyTavern-TagLibrary extension. Tags stored directly on character cards via SillyTavern's built-in tag system come across automatically with the character import and don't need this step.

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
