#!/usr/bin/env bash
set -euo pipefail

# ─── Lumiverse Launcher (macOS / Linux) ───────────────────────────────────────
# Usage:
#   ./start.sh                  Start backend, serve pre-built frontend (default)
#   ./start.sh -b|--build       Rebuild frontend before starting backend
#   ./start.sh --build-only     Build frontend only, don't start backend
#   ./start.sh --backend-only   Start backend only, skip frontend serving
#   ./start.sh --dev            Start backend in watch mode (no frontend build)
#   ./start.sh --setup          Run setup wizard only
#   ./start.sh --reset-password  Reset owner account password
#   ./start.sh -m|--migrate-st  Run SillyTavern migration helper
#   ./start.sh --no-runner      Start without the visual runner
#
# Environment overrides:
#   FRONTEND_PATH   Path to frontend directory (default: ./frontend)
# ──────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[error]${NC} $*" >&2; }

# ─── Platform detection ─────────────────────────────────────────────────────

IS_TERMUX=false
IS_PROOT=false
TERMUX_BUN_METHOD=""  # "direct" | "grun" | "proot" — how to invoke bun on Termux
TERMUX_BUN_PATH=""    # Full resolved path to bun binary (needed for grun/proot)

# Detect native Termux: $PREFIX is always set in Termux shell sessions
if [[ -n "${PREFIX:-}" && -d "/data/data/com.termux" ]]; then
  IS_TERMUX=true
# Detect proot-distro inside Termux (running a full Linux distro)
elif [[ -f "/etc/os-release" && -d "/data/data/com.termux" ]] 2>/dev/null; then
  IS_PROOT=true
fi

# ─── Bun execution wrapper ─────────────────────────────────────────────────
# On Termux, the raw bun binary can't execute natively (glibc vs bionic libc).
# _bun routes through the best available method. _proot_bun always wraps in
# proot for operations that need syscall interception (e.g. bun install).
_bun() {
  if [[ "$IS_TERMUX" == true && -n "$TERMUX_BUN_PATH" ]]; then
    case "$TERMUX_BUN_METHOD" in
      direct)
        # bun-termux wrapper handles linker + /proc/self/exe
        "$TERMUX_BUN_PATH" "$@" ;;
      grun)
        # glibc-runner invokes ld.so explicitly (must use full path)
        grun "$TERMUX_BUN_PATH" "$@" ;;
      proot)
        # proot intercepts syscalls + explicit glibc linker invocation
        proot --link2symlink -0 \
          "${PREFIX}/glibc/lib/ld-linux-aarch64.so.1" \
          --library-path "${PREFIX}/glibc/lib" \
          "$TERMUX_BUN_PATH" "$@" ;;
      *)
        "$TERMUX_BUN_PATH" "$@" ;;
    esac
  else
    bun "$@"
  fi
}

# Like _bun but guarantees proot wrapping — used for bun install where
# Android's seccomp filter blocks syscalls even when grun works otherwise.
_proot_bun() {
  local bun_path="${TERMUX_BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
  local glibc_ld="${PREFIX:-/data/data/com.termux/files/usr}/glibc/lib/ld-linux-aarch64.so.1"

  if [[ "$TERMUX_BUN_METHOD" == "direct" ]]; then
    # bun-termux wrapper handles linker; proot adds syscall interception
    proot --link2symlink -0 "$bun_path" "$@"
  elif [[ -x "$glibc_ld" ]]; then
    # Explicit glibc linker + proot for full coverage
    proot --link2symlink -0 "$glibc_ld" --library-path "${PREFIX}/glibc/lib" "$bun_path" "$@"
  else
    # Last resort — hope proot alone handles it
    proot --link2symlink -0 "$bun_path" "$@"
  fi
}

# ─── Parse arguments ─────────────────────────────────────────────────────────

MODE="all"  # all | build-only | backend-only | dev | setup | reset-password | migrate-st
USE_RUNNER=true
FORCE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --build|-b)     FORCE_BUILD=true ;;
    --build-only)   MODE="build-only" ;;
    --backend-only) MODE="backend-only" ;;
    --dev)          MODE="dev" ;;
    --setup)        MODE="setup" ;;
    --reset-password) MODE="reset-password" ;;
    --migrate-st|-m) MODE="migrate-st" ;;
    --no-runner)    USE_RUNNER=false ;;
    --help|-h)
      sed -n '3,15p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ─── Resolve paths ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR"
FRONTEND_DIR="${FRONTEND_PATH:-$SCRIPT_DIR/frontend}"

# ─── Ensure Bun is installed ────────────────────────────────────────────────

# Try to find bun in PATH or common install locations.
# Called at the start and after install attempts.
_resolve_bun() {
  # Load Bun env early — catches cases where Bun was previously installed
  # but the current shell session hasn't sourced the profile yet.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  [[ -f "$BUN_INSTALL/env" ]] && source "$BUN_INSTALL/env"

  # Build list of candidate paths
  local candidates=()
  local found
  found="$(command -v bun 2>/dev/null || true)"
  [[ -n "$found" ]] && candidates+=("$found")
  candidates+=(
    "$BUN_INSTALL/bin/bun"
    "$HOME/.bun/bin/bun"
    "/root/.bun/bin/bun"
  )

  for try in "${candidates[@]}"; do
    [[ -x "$try" ]] || continue

    # On Termux, the binary may exist with +x but fail to execute due to
    # missing glibc linker or seccomp restrictions. Verify it actually runs.
    if [[ "$IS_TERMUX" == true ]]; then
      # Tier 1: direct execution (bun-termux wrapper or native)
      # Subshell suppresses shell-level signal diagnostics (e.g. "Bad system call")
      if ("$try" --version) &>/dev/null 2>&1; then
        TERMUX_BUN_METHOD="direct"
        TERMUX_BUN_PATH="$try"
        # Only add raw bun to PATH when it can execute natively
        export PATH="$(dirname "$try"):$PATH"
        return 0
      fi
      # Tier 2: grun (glibc-runner) — invokes glibc's ld.so explicitly
      # Don't add raw bun to PATH — it can't execute without grun
      if command -v grun &>/dev/null && (grun "$try" --version) &>/dev/null 2>&1; then
        TERMUX_BUN_METHOD="grun"
        TERMUX_BUN_PATH="$try"
        return 0
      fi
      # Tier 3: proot + explicit glibc linker (slower but most compatible)
      # Don't add raw bun to PATH — it can't execute without proot
      local glibc_ld="${PREFIX:-}/glibc/lib/ld-linux-aarch64.so.1"
      if [[ -x "$glibc_ld" ]] && command -v proot &>/dev/null \
         && (proot --link2symlink -0 "$glibc_ld" --library-path "${PREFIX}/glibc/lib" "$try" --version) &>/dev/null 2>&1; then
        TERMUX_BUN_METHOD="proot"
        TERMUX_BUN_PATH="$try"
        return 0
      fi
      continue  # Binary exists but can't execute — try next candidate
    fi

    export PATH="$(dirname "$try"):$PATH"
    return 0
  done

  return 1
}

# Install Termux prerequisites for running glibc-linked Bun binaries.
# Bun is compiled against glibc, but Termux uses Android's bionic libc.
# We need glibc-runner to bridge the gap, plus bun-termux for a proper
# wrapper that handles /proc/self/exe, hardlink stubs, and path remapping.
_install_bun_termux() {
  info "Termux detected — installing Bun with glibc compatibility layer..."

  if ! command -v pkg &>/dev/null; then
    err "Termux 'pkg' package manager not found."
    exit 1
  fi

  # ── Step 1: Base packages ────────────────────────────────────────────────
  info "Installing base Termux prerequisites..."
  pkg update -y
  pkg install -y git curl build-essential proot

  # ── Step 2: Set up the glibc repository ──────────────────────────────────
  # glibc-runner lives in a separate repo (termux-glibc), NOT the default
  # termux-main repo. The glibc-repo package registers this repo source.
  info "Setting up glibc package repository..."
  local glibc_runner_installed=false
  local glibc_sources_dir="${PREFIX}/etc/apt/sources.list.d"

  # Try installing glibc-repo (the repo enabler package)
  if pkg install -y glibc-repo 2>/dev/null; then
    # Verify the glibc repo source was actually registered
    if ls "${glibc_sources_dir}/"*glibc* &>/dev/null 2>&1; then
      info "glibc repository registered, refreshing package lists..."
    else
      warn "glibc-repo installed but repo source not found — adding manually..."
      mkdir -p "$glibc_sources_dir"
      echo "deb https://packages-cf.termux.dev/apt/termux-glibc stable main" \
        > "${glibc_sources_dir}/glibc.list"
    fi
  else
    warn "glibc-repo package not available — adding glibc repository manually..."
    mkdir -p "$glibc_sources_dir"
    echo "deb https://packages-cf.termux.dev/apt/termux-glibc stable main" \
      > "${glibc_sources_dir}/glibc.list"
  fi

  # Refresh package lists to pick up the glibc repo
  pkg update -y 2>/dev/null || apt-get update -y 2>/dev/null || true

  # ── Step 3: Install glibc-runner ─────────────────────────────────────────
  if pkg install -y glibc-runner 2>/dev/null; then
    glibc_runner_installed=true
    ok "glibc-runner installed via apt"
  else
    warn "glibc-runner not found via apt — trying alternate mirror..."
    # Some mirrors don't serve termux-glibc; try the primary mirror directly
    mkdir -p "$glibc_sources_dir"
    echo "deb https://packages.termux.dev/apt/termux-glibc stable main" \
      > "${glibc_sources_dir}/glibc.list"
    if apt-get update -y 2>/dev/null && pkg install -y glibc-runner 2>/dev/null; then
      glibc_runner_installed=true
      ok "glibc-runner installed via apt (alternate mirror)"
    fi
  fi

  # ── Step 4: Pacman fallback ──────────────────────────────────────────────
  if [[ "$glibc_runner_installed" != true ]]; then
    warn "apt-based glibc-runner install failed — trying pacman fallback..."
    if pkg install -y pacman 2>/dev/null; then
      pacman-key --init 2>/dev/null || true
      pacman-key --populate 2>/dev/null || true
      if pacman -Sy --noconfirm glibc-runner 2>/dev/null; then
        glibc_runner_installed=true
        ok "glibc-runner installed via pacman"
      fi
    fi
  fi

  if [[ "$glibc_runner_installed" != true ]]; then
    warn "Could not install glibc-runner through any method."
    warn "Bun may still work via proot fallback, or consider using proot-distro:"
    warn "  pkg install proot-distro && proot-distro install ubuntu"
    warn "  proot-distro login ubuntu"
    warn "  # Then re-run this script inside the Ubuntu environment"
  fi

  # The official Bun installer downloads the linux-aarch64 glibc binary,
  # which is exactly what we need — glibc-runner will execute it.
  touch "$HOME/.bashrc" 2>/dev/null || true
  curl -fsSL https://bun.sh/install | bash
  source "$HOME/.bashrc" 2>/dev/null || true

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  [[ -f "$BUN_INSTALL/env" ]] && source "$BUN_INSTALL/env"

  # Install bun-termux wrapper (userland-exec + LD_PRELOAD shim)
  # This replaces the raw bun binary with a wrapper that:
  #   - Loads glibc's ld-linux via userland exec (fixes /proc/self/exe)
  #   - Intercepts syscalls for Android filesystem compatibility
  #   - Remaps shebang paths to Termux prefix
  if [[ ! -d "$HOME/.bun-termux" ]]; then
    info "Installing bun-termux wrapper..."
    if git clone https://github.com/Happ1ness-dev/bun-termux.git "$HOME/.bun-termux" 2>/dev/null \
       && (cd "$HOME/.bun-termux" && make && make install) 2>/dev/null; then
      ok "bun-termux wrapper installed"
    else
      warn "bun-termux wrapper build failed — will use grun (glibc-runner) fallback"
      rm -rf "$HOME/.bun-termux" 2>/dev/null || true
    fi
  else
    info "bun-termux wrapper already present, skipping..."
  fi

  # Determine which execution method works (same 3-tier detection as _resolve_bun)
  local bun_bin="${BUN_INSTALL}/bin/bun"
  local glibc_ld="${PREFIX}/glibc/lib/ld-linux-aarch64.so.1"
  if [[ -x "$bun_bin" ]] && ("$bun_bin" --version) &>/dev/null 2>&1; then
    TERMUX_BUN_METHOD="direct"
    TERMUX_BUN_PATH="$bun_bin"
  elif command -v grun &>/dev/null && (grun "$bun_bin" --version) &>/dev/null 2>&1; then
    TERMUX_BUN_METHOD="grun"
    TERMUX_BUN_PATH="$bun_bin"
    warn "Using grun (glibc-runner) to execute Bun — bun-termux wrapper not functional"
  elif [[ -x "$glibc_ld" ]] && command -v proot &>/dev/null \
       && (proot --link2symlink -0 "$glibc_ld" --library-path "${PREFIX}/glibc/lib" "$bun_bin" --version) &>/dev/null 2>&1; then
    TERMUX_BUN_METHOD="proot"
    TERMUX_BUN_PATH="$bun_bin"
    warn "Using proot + glibc linker to execute Bun (slower — bun-termux and grun both failed)"
  fi
}

# Set up convenience aliases in Termux's ~/.bashrc when proot-distro is available.
# This lets users type 'p' to enter proot or 'l' to launch Lumiverse directly.
setup_proot_aliases() {
  if [[ "$IS_TERMUX" != true ]]; then return; fi
  if ! command -v proot-distro &>/dev/null; then return; fi

  local bashrc="$HOME/.bashrc"

  # Skip if aliases already exist (ours or user-defined) to avoid duplicates
  if [[ -f "$bashrc" ]] && grep -qE "^alias [pl]=" "$bashrc"; then
    return
  fi

  info "proot-distro detected — adding convenience aliases to ~/.bashrc..."

  touch "$bashrc" 2>/dev/null || true
  cat >> "$bashrc" <<'ALIASES'

# Lumiverse proot-distro aliases
alias p='proot-distro login ubuntu'
alias l='proot-distro login ubuntu -- bash -lc "export BUN_INSTALL=/root/.bun; export PATH=\$BUN_INSTALL/bin:\$PATH; echo Using bun at: /root/.bun/bin/bun; /root/.bun/bin/bun --version; cd /root/Lumiverse && ./start.sh"'
ALIASES

  ok "Added aliases to ~/.bashrc: 'p' (proot login), 'l' (launch Lumiverse in proot)"

  # Refresh environment so aliases and env vars take effect in this session
  source "$bashrc" 2>/dev/null || true
}

ensure_bun() {
  # ── Try to resolve an existing Bun installation ──────────────────────────
  if _resolve_bun; then
    # Capture only the first line — bun may dump its full help text to stdout
    # through some execution methods, and we don't want that in the status line
    local ver
    ver="$(_bun --version 2>/dev/null | head -1 || echo 'unknown')"
    case "$TERMUX_BUN_METHOD" in
      grun)  ok "Bun $ver found (via glibc-runner)" ;;
      proot) ok "Bun $ver found (via proot + glibc linker)" ;;
      *)     ok "Bun $ver found" ;;
    esac
    return
  fi

  # ── No Bun found — install it ───────────────────────────────────────────
  warn "Bun not found. Installing..."

  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    err "On Windows, please run start.ps1 instead, or install Bun manually:"
    err "  powershell -c \"irm bun.sh/install.ps1 | iex\""
    exit 1
  fi

  if [[ "$IS_TERMUX" == true ]]; then
    _install_bun_termux
  else
    curl -fsSL https://bun.sh/install | bash
  fi

  # ── Make bun available in this session ──────────────────────────────────
  if _resolve_bun; then
    local ver
    ver="$(_bun --version 2>/dev/null | head -1 || echo 'unknown')"
    case "$TERMUX_BUN_METHOD" in
      grun)  ok "Bun $ver installed (via glibc-runner)" ;;
      proot) ok "Bun $ver installed (via proot + glibc linker)" ;;
      *)     ok "Bun $ver installed successfully" ;;
    esac
    return
  fi

  # ── Installation failed ─────────────────────────────────────────────────
  if [[ "$IS_TERMUX" == true ]]; then
    err "Bun installation failed on Termux."
    err "You can also try running inside proot-distro:"
    err "  pkg install proot-distro && proot-distro install ubuntu"
    err "  proot-distro login ubuntu"
    err "  # Then re-run this script inside the Ubuntu environment"
  else
    err "Bun installation failed. Please install manually: https://bun.sh"
  fi
  exit 1
}

# ─── First-run setup wizard ─────────────────────────────────────────────────

run_setup_if_needed() {
  local identity_file="$BACKEND_DIR/data/lumiverse.identity"
  local env_file="$BACKEND_DIR/.env"

  # Run wizard if identity file or .env doesn't exist
  if [[ ! -f "$identity_file" || ! -f "$env_file" ]]; then
    info "First run detected — launching setup wizard..."
    echo ""
    install_deps "$BACKEND_DIR" "backend"
    (cd "$BACKEND_DIR" && _bun run scripts/setup-wizard.ts)
  fi
}

run_setup() {
  install_deps "$BACKEND_DIR" "backend"
  (cd "$BACKEND_DIR" && _bun run scripts/setup-wizard.ts)
}

run_reset_password() {
  install_deps "$BACKEND_DIR" "backend"
  info "Launching password reset..."
  (cd "$BACKEND_DIR" && _bun run reset-password)
}

run_migrate_st() {
  install_deps "$BACKEND_DIR" "backend"
  info "Launching SillyTavern migration helper..."
  (cd "$BACKEND_DIR" && _bun run migrate:st)
}

# ─── Install dependencies ───────────────────────────────────────────────────

install_deps() {
  local dir="$1"
  local name="$2"

  info "Installing $name dependencies..."

  if [[ "$IS_TERMUX" == true ]]; then
    # Android doesn't support hardlinks — use file copy backend instead.
    # Clear Bun's install cache first — filesystem emulation can corrupt
    # cached packages, causing random "Cannot find package" errors.
    if [[ -d "$HOME/.bun/install/cache" ]]; then
      rm -rf "$HOME/.bun/install/cache"
    fi
    # Always wrap bun install in proot on Termux — Android's seccomp filter
    # blocks certain syscalls that bun install needs, causing "Bad system call"
    # (SIGSYS) errors. _proot_bun handles both linker and syscall issues.
    (cd "$dir" && _proot_bun install --backend=copyfile)
  elif [[ "$IS_PROOT" == true ]]; then
    # Inside proot-distro: proot already intercepts syscalls, just need copyfile backend
    if [[ -d "$HOME/.bun/install/cache" ]]; then
      rm -rf "$HOME/.bun/install/cache"
    fi
    (cd "$dir" && bun install --backend=copyfile)
  else
    (cd "$dir" && bun install)
  fi

  ok "$name dependencies installed"
}

# ─── Build frontend ─────────────────────────────────────────────────────────

build_frontend() {
  if [[ ! -d "$FRONTEND_DIR" ]]; then
    err "Frontend directory not found at: $FRONTEND_DIR"
    err "Set FRONTEND_PATH to the correct location."
    exit 1
  fi

  install_deps "$FRONTEND_DIR" "frontend"

  info "Building frontend..."
  (cd "$FRONTEND_DIR" && _bun run build)
  ok "Frontend built -> $FRONTEND_DIR/dist"
}

# ─── Start backend ──────────────────────────────────────────────────────────

start_backend() {
  local frontend_dist=""

  # Point to frontend dist if it exists (skip in dev mode — Vite proxies)
  if [[ "$MODE" != "dev" && -d "$FRONTEND_DIR/dist" ]]; then
    frontend_dist="$FRONTEND_DIR/dist"
    info "Serving frontend from: $frontend_dist"
  elif [[ "$MODE" != "dev" ]]; then
    warn "No frontend build found. Backend will start without serving frontend."
    warn "Run './start.sh --build-only' first, or use './start.sh' to build + start."
  fi

  install_deps "$BACKEND_DIR" "backend"

  # Clear Bun transpiler cache to avoid stale bytecode after updates
  _bun --clear-cache 2>/dev/null || true

  # Export FRONTEND_DIR for the backend process
  export FRONTEND_DIR="$frontend_dist"

  # Load .env for PORT and other vars
  if [[ -f "$BACKEND_DIR/.env" ]]; then
    set -a
    source "$BACKEND_DIR/.env"
    set +a
  fi

  # Disable the Ink TUI runner on Termux/proot — the React/Ink devDependencies
  # are unreliable on Android's filesystem and the TUI doesn't render well on
  # mobile terminal emulators.
  if [[ "$IS_TERMUX" == true || "$IS_PROOT" == true ]]; then
    USE_RUNNER=false
  fi

  # Decide: visual runner or plain process
  if [[ "$USE_RUNNER" == true ]] && [[ -t 1 ]]; then
    # Interactive terminal — use the visual runner (fall back to plain if it crashes)
    local runner_args=""
    if [[ "$MODE" == "dev" ]]; then
      runner_args="-- --dev"
    fi
    (cd "$BACKEND_DIR" && _bun run scripts/runner.tsx $runner_args) || {
      warn "Visual runner failed — falling back to plain mode..."
      USE_RUNNER=false
    }
  fi

  if [[ "$USE_RUNNER" != true ]]; then
    # Non-interactive (piped, CI, --no-runner) — plain process
    echo ""
    echo -e "${BOLD}Starting Lumiverse Backend on port ${PORT:-7860}...${NC}"
    echo ""

    if [[ "$MODE" == "dev" ]]; then
      (cd "$BACKEND_DIR" && _bun run dev)
    else
      (cd "$BACKEND_DIR" && _bun run start)
    fi
  fi
}

# ─── Export Termux bun method for child processes ─────────────────────────
# The Spindle extension manager spawns bun subprocesses and needs to know
# how to invoke bun on Termux (direct / grun / proot wrapping).
export_termux_bun_env() {
  if [[ "$IS_TERMUX" == true ]]; then
    export LUMIVERSE_IS_TERMUX="true"
    export LUMIVERSE_BUN_METHOD="$TERMUX_BUN_METHOD"
    export LUMIVERSE_BUN_PATH="$TERMUX_BUN_PATH"
  elif [[ "$IS_PROOT" == true ]]; then
    export LUMIVERSE_IS_PROOT="true"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Lumiverse${NC} — Launcher"
echo ""

if [[ "$IS_TERMUX" == true ]]; then
  info "Running on Termux (Android)"
elif [[ "$IS_PROOT" == true ]]; then
  info "Running inside proot-distro (Android)"
fi

setup_proot_aliases
ensure_bun
export_termux_bun_env

case "$MODE" in
  all)
    run_setup_if_needed
    if [[ "$FORCE_BUILD" == true ]]; then
      build_frontend
    fi
    start_backend
    ;;
  build-only)
    build_frontend
    ;;
  backend-only)
    run_setup_if_needed
    start_backend
    ;;
  dev)
    run_setup_if_needed
    start_backend
    ;;
  setup)
    run_setup
    ;;
  reset-password)
    run_reset_password
    ;;
  migrate-st)
    run_migrate_st
    ;;
esac
